"""Tests for voice agent module."""

from unittest.mock import patch

import pytest


class TestCreateLiveKitRoom:
    """Test LiveKit room creation."""

    @pytest.mark.asyncio
    async def test_create_livekit_room_success(self):
        """Test create_livekit_room function exists and is async."""
        import asyncio

        from samvaad.interfaces.voice_agent import create_livekit_room

        # Verify it's an async function
        assert asyncio.iscoroutinefunction(create_livekit_room)

    @pytest.mark.asyncio
    @patch("samvaad.interfaces.voice_agent.os.getenv")
    async def test_create_livekit_room_missing_config(self, mock_getenv):
        """Test error when LiveKit config is missing."""
        from samvaad.interfaces.voice_agent import create_livekit_room

        mock_getenv.return_value = None

        with pytest.raises(ValueError, match="LIVEKIT_URL"):
            await create_livekit_room()


class TestDeleteLiveKitRoom:
    """Test LiveKit room deletion."""

    @pytest.mark.asyncio
    async def test_delete_livekit_room_success(self):
        """Test delete_livekit_room function exists and is async."""
        import asyncio

        from samvaad.interfaces.voice_agent import delete_livekit_room

        # Verify it's an async function
        assert asyncio.iscoroutinefunction(delete_livekit_room)


class TestVoiceAgentImports:
    """Test voice_agent module can be imported."""

    def test_module_imports(self):
        """Test voice_agent module imports without error."""
        try:
            from samvaad.interfaces import voice_agent
            assert voice_agent is not None
        except ImportError as e:
            pytest.skip(f"voice_agent dependencies not available: {e}")

    def test_create_livekit_room_exists(self):
        """Test create_livekit_room function exists."""
        from samvaad.interfaces.voice_agent import create_livekit_room
        assert callable(create_livekit_room)

    def test_start_voice_agent_exists(self):
        """Test start_voice_agent function exists."""
        from samvaad.interfaces.voice_agent import start_voice_agent
        assert callable(start_voice_agent)

    def test_delete_livekit_room_exists(self):
        """Test delete_livekit_room function exists."""
        from samvaad.interfaces.voice_agent import delete_livekit_room
        assert callable(delete_livekit_room)
