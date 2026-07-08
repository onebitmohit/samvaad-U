import asyncio
import json
import os
import time
import uuid
from typing import Any, cast

import aiohttp
import jwt
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.pipeline.base_task import PipelineTaskParams
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.processors.aggregators.llm_context import NOT_GIVEN
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.processors.frame_processor import FrameDirection
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.groq.llm import GroqLLMService
from pipecat.transports.livekit.transport import LiveKitParams, LiveKitTransport
from pipecat.transports.livekit.utils import LiveKitRESTHelper
from pipecat.utils.text.markdown_text_filter import MarkdownTextFilter

from samvaad.core.types import ConversationMode
from samvaad.core.unified_context import SamvaadLLMContext
from samvaad.pipeline.retrieval.query import rag_query_pipeline
from samvaad.prompts import PromptBuilder
from samvaad.utils.citations import format_rag_context
from samvaad.utils.logger import logger
from samvaad.utils.text_filters import CitationTextFilter


class LiveKitMessageObserver(BaseObserver):
    def __init__(self, llm: GroqLLMService, context: SamvaadLLMContext, transport: LiveKitTransport) -> None:
        super().__init__()
        self._llm = llm
        self._context = context
        self._transport = transport
        self._aggregated_text = ""
        self._is_aggregating = False

    async def _send_message(self, payload: dict[str, Any]) -> None:
        try:
            await self._transport.send_message(json.dumps(payload))
        except Exception as e:
            logger.error(f"[LiveKitMessageObserver] Failed to send message: {e}")

    async def on_push_frame(self, data: FramePushed):
        if data.direction != FrameDirection.DOWNSTREAM:
            return

        frame = data.frame
        if isinstance(frame, UserStartedSpeakingFrame):
            await self._send_message({"type": "user_started_speaking"})
            self._context.set_pending_raw_assistant_text("")
            return
        if isinstance(frame, TranscriptionFrame) and frame.text.strip():
            await self._send_message(
                {"type": "user_transcript", "text": frame.text.strip(), "final": True}
            )
            return
        if isinstance(frame, BotStartedSpeakingFrame):
            await self._send_message({"type": "bot_started_speaking"})
            return
        if isinstance(frame, BotStoppedSpeakingFrame):
            await self._send_message({"type": "bot_stopped_speaking"})
            return

        if data.source is not self._llm:
            return

        if isinstance(frame, LLMFullResponseStartFrame):
            self._is_aggregating = True
            self._aggregated_text = ""
            await self._send_message({"type": "bot_llm_started"})
        elif isinstance(frame, LLMTextFrame) and self._is_aggregating:
            self._aggregated_text += frame.text
            await self._send_message({"type": "bot_llm_text", "text": frame.text})
        elif isinstance(frame, LLMFullResponseEndFrame) and self._is_aggregating:
            if self._aggregated_text.strip():
                text = self._aggregated_text.strip()
                self._context.set_pending_raw_assistant_text(text)
                await self._send_message({"type": "transcript", "text": text})
                logger.debug(f"[LiveKitMessageObserver] Sent transcript to frontend: {text[:100]}...")
            self._aggregated_text = ""
            self._is_aggregating = False


def _livekit_config() -> tuple[str, str, str]:
    url = os.getenv("LIVEKIT_URL")
    api_key = os.getenv("LIVEKIT_API_KEY")
    api_secret = os.getenv("LIVEKIT_API_SECRET")
    if not url:
        raise ValueError("LIVEKIT_URL is not set in environment variables")
    if not api_key:
        raise ValueError("LIVEKIT_API_KEY is not set in environment variables")
    if not api_secret:
        raise ValueError("LIVEKIT_API_SECRET is not set in environment variables")
    return url, api_key, api_secret


def _create_livekit_token(
    *,
    api_key: str,
    api_secret: str,
    identity: str,
    room_name: str,
    room_create: bool = False,
) -> str:
    now = int(time.time())
    claims = {
        "iss": api_key,
        "sub": identity,
        "nbf": now,
        "exp": now + 3600,
        "video": {
            "room": room_name,
            "roomJoin": True,
            "roomCreate": room_create,
            "canPublish": True,
            "canSubscribe": True,
            "canPublishData": True,
        },
    }
    return jwt.encode(claims, api_secret, algorithm="HS256")


async def create_livekit_room(user_id: str | None = None) -> tuple[str, str, str, str]:
    """Create a temporary LiveKit room name and signed user/bot access tokens."""
    url, api_key, api_secret = _livekit_config()
    room_name = f"samvaad-{uuid.uuid4().hex}"
    user_identity = f"user-{user_id or uuid.uuid4().hex}"
    user_token = _create_livekit_token(
        api_key=api_key,
        api_secret=api_secret,
        identity=user_identity,
        room_name=room_name,
    )
    bot_token = _create_livekit_token(
        api_key=api_key,
        api_secret=api_secret,
        identity=f"samvaad-bot-{uuid.uuid4().hex[:8]}",
        room_name=room_name,
        room_create=True,
    )
    return url, room_name, user_token, bot_token


async def delete_livekit_room(room_name: str) -> bool:
    """Delete a LiveKit room if the server supports the RoomService API."""
    if not room_name:
        logger.warning("No LiveKit room name provided for cleanup")
        return False

    url, api_key, api_secret = _livekit_config()
    api_url = url.replace("ws://", "http://").replace("wss://", "https://")

    try:
        async with aiohttp.ClientSession() as session:
            helper = LiveKitRESTHelper(
                api_key=api_key,
                api_secret=api_secret,
                api_url=api_url,
                aiohttp_session=session,
            )
            await helper.delete_room_by_name(room_name)
            logger.info(f"LiveKit room {room_name} deleted successfully")
            return True
    except Exception as e:
        logger.warning(f"Error deleting LiveKit room {room_name}: {e}")
        return False


async def start_voice_agent(
    livekit_url: str,
    room_name: str,
    token: str,
    user_id: str,
    conversation_id: str,
    enable_tts: bool = True,
    persona: str = "default",
    strict_mode: bool = False,
):
    """Entry point to start the bot in a specific LiveKit room."""

    deepgram_api_key = os.getenv("DEEPGRAM_API_KEY")
    if not deepgram_api_key:
        raise ValueError("DEEPGRAM_API_KEY is not set in environment variables")
    groq_api_key = os.getenv("GROQ_API_KEY")
    if not groq_api_key:
        raise ValueError("GROQ_API_KEY is not set in environment variables")

    # 1. Define Transport
    # VAD parameters tuned for better interruption handling:
    # - confidence=0.8: Higher threshold to avoid false positives from noise
    # - start_secs=0.5: User must speak for 0.5s before triggering (prevents accidental interrupts)
    # - stop_secs=1.0: Allow 1 second of silence before considering speech complete
    #                  (higher value = fewer splits but slower response time)
    # - min_volume=0.7: Filter out quiet background noise
    vad_analyzer = SileroVADAnalyzer(params=VADParams(confidence=0.8, start_secs=0.5, stop_secs=1.0, min_volume=0.7))
    transport = LiveKitTransport(
        url=livekit_url,
        room_name=room_name,
        token=token,
        params=LiveKitParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            vad_analyzer=vad_analyzer,
        ),
    )

    # 3. Define Tools (The RAG Integration)
    RAG_TIMEOUT_SECONDS = 10.0
    context: SamvaadLLMContext | None = None

    async def fetch_context(function_call_params):
        query = ""
        try:
            # [SECURITY-FIX #74] Strict validation of tool arguments
            args = function_call_params.arguments
            if not isinstance(args, dict):
                raise ValueError("Invalid arguments format")

            query = args.get("query")
            if not isinstance(query, str) or not query.strip():
                raise ValueError("Query must be a non-empty string")

            # Sanitize length to prevent excessive processing
            if len(query) > 500:
                query = query[:500]

            logger.info(f"RAG Tool Triggered: {query} (user_id: {user_id})")

            sources = []
            # Run blocking RAG code with timeout to avoid hanging
            result = await asyncio.wait_for(
                asyncio.to_thread(rag_query_pipeline, query, user_id=user_id, file_ids=None),
                timeout=RAG_TIMEOUT_SECONDS,
            )

            chunks = result.get("chunks", [])
            rag_text = format_rag_context(chunks)

            if chunks:
                logger.info(f"[voice_agent] RAG formatted {len(chunks)} chunks with XML tags")
                logger.debug(f"[voice_agent] RAG context preview: {rag_text[:300]}...")

                for chunk in chunks[:3]:
                    sources.append(
                        {
                            "filename": chunk.get("filename", "document"),
                            "content_preview": chunk.get("content", "")[:1000],
                            "rerank_score": chunk.get("rerank_score"),
                            "chunk_id": chunk.get("chunk_id"),
                            "metadata": chunk.get("metadata", {}),
                        }
                    )
            else:
                logger.warning("[voice_agent] RAG returned no chunks")

        except TimeoutError:
            logger.warning(f"[voice_agent] RAG timeout after {RAG_TIMEOUT_SECONDS}s for query: {query}")
            rag_text = "Search timed out. Please try your question again."
            sources = []
        except ValueError as e:
            logger.warning(f"[voice_agent] Tool validation error: {e}")
            rag_text = f"Invalid search request: {e}"
            sources = []
        except Exception as e:
            logger.error(f"[voice_agent] RAG error: {e}")
            rag_text = "An error occurred while searching. Please try again."
            sources = []

        # Send citations to frontend via LiveKit data message.
        if sources:
            try:
                await transport.send_message(json.dumps({"type": "citations", "sources": sources}))
                logger.debug(f"[voice_agent] Sent {len(sources)} citations to frontend")
            except Exception as e:
                logger.error(f"[voice_agent] Failed to send citations: {e}")

            if context:
                context.set_pending_sources(sources)

        if strict_mode and context:
            context.set_tool_choice(NOT_GIVEN)

        await function_call_params.result_callback(rag_text)

    # OpenAI-compatible tool format for Groq
    fetch_context_schema = FunctionSchema(
        name="fetch_context",
        description=(
            "Search the knowledge base for information. IMPORTANT: Call this tool ONLY ONCE "
            "per user question. If the search does not return relevant information, answer "
            "based on your own knowledge instead of searching again. Do NOT retry with a "
            "modified query."
        ),
        properties={
            "query": {
                "type": "string",
                "description": "The search query - use the user's key terms or topic",
            }
        },
        required=["query"],
    )

    tools_schema = ToolsSchema(standard_tools=[fetch_context_schema])
    stt = DeepgramSTTService(api_key=deepgram_api_key, base_url="wss://api.eu.deepgram.com/v1/listen")
    md_filter = MarkdownTextFilter()
    citation_filter = CitationTextFilter()

    # 4. Context & Persona - Use unified context manager for consistent prompts
    system_instruction = (
        PromptBuilder()
        .with_persona(persona)
        .with_strict_mode(strict_mode)
        .with_mode(ConversationMode.VOICE)
        .with_tools()
        .build()
    )

    # Use Groq with llama-3.3-70b-versatile (same as text mode for consistent citation behavior)
    llm = GroqLLMService(api_key=groq_api_key, model="llama-3.3-70b-versatile")
    llm.register_function("fetch_context", fetch_context)

    # Context Manager (Keeps track of conversation history)
    # Use SamvaadLLMContext for database persistence
    # Migration (2025-01): Now uses LLMContextAggregatorPair instead of deprecated llm.create_context_aggregator
    tool_choice = {"type": "function", "function": {"name": "fetch_context"}} if strict_mode else "auto"
    context = SamvaadLLMContext(
        conversation_id=conversation_id, user_id=user_id, tools=tools_schema, tool_choice=tool_choice
    )
    context.load_history()  # Load existing messages from DB

    context.add_message(
        {
            "role": "system",
            "content": system_instruction,
        }
    )
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(context)

    processors = [
        transport.input(),
        stt,
        user_aggregator,
        llm,
    ]

    if enable_tts:
        tts = DeepgramTTSService(
            api_key=deepgram_api_key,
            base_url="wss://api.eu.deepgram.com",  # EU endpoint for better connectivity
            voice="aura-2-asteria-en",
            encoding="linear16",
            text_filters=[md_filter, citation_filter],  # Strip markdown and citations from TTS
        )
        processors.append(tts)

    processors.append(assistant_aggregator)
    processors.append(transport.output())  # Audio out (or text frames if TTS missing)

    pipeline = Pipeline(processors)

    # Cleanup flag to prevent duplicate cleanup (both events can fire)
    cleanup_done = False

    async def do_cleanup(reason: str):
        nonlocal cleanup_done
        if cleanup_done:
            logger.info(f"[voice_agent] Cleanup already done, skipping ({reason})")
            return
        cleanup_done = True
        logger.info(f"[voice_agent] Cleaning up - {reason}")
        await delete_livekit_room(room_name)
        await task.cancel()

    @transport.event_handler("on_connected")
    async def on_connected(transport_obj):
        logger.info(f"[voice_agent] Connected to LiveKit room: {room_name}")
        await transport.send_message(json.dumps({"type": "bot_ready"}))

    @transport.event_handler("on_participant_disconnected")
    async def on_participant_disconnected(transport_obj, participant_id):
        logger.info(f"[voice_agent] Participant disconnected: {participant_id}")
        await do_cleanup("participant_disconnected")

    # 9. Run the pipeline with 60-second idle timeout
    pipeline_params = PipelineParams(
        allow_interruptions=True,
        enable_metrics=True,
    )
    task = PipelineTask(
        pipeline,
        params=pipeline_params,
        observers=[LiveKitMessageObserver(llm, context, transport)],
        idle_timeout_secs=60,
        cancel_on_idle_timeout=True,
    )
    task_params = PipelineTaskParams(loop=asyncio.get_event_loop())
    await task.run(task_params)
