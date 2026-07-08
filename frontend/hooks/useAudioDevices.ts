import { useEffect, useState } from "react";

interface AudioDevices {
	mics: MediaDeviceInfo[];
	speakers: MediaDeviceInfo[];
	selectedMic: MediaDeviceInfo | null;
	selectedSpeakerId: string;
	updateMic: (deviceId: string) => void;
	setSelectedSpeakerId: (deviceId: string) => void;
}

/**
 * Hook to manage audio input/output device enumeration and selection.
 * Centralizes device management logic used across voice settings components.
 */
export function useAudioDevices(): AudioDevices {
	const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
	const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
	const [selectedMicId, setSelectedMicId] = useState<string>("");
	const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>("");

	useEffect(() => {
		const enumerateDevices = async () => {
			try {
				// Request mic permission to get device labels
				try {
					const stream = await navigator.mediaDevices.getUserMedia({
						audio: true,
					});
					stream.getTracks().forEach((track) => track.stop());
				} catch (permErr) {
					console.debug("Mic permission not yet granted:", permErr);
				}

				const devices = await navigator.mediaDevices.enumerateDevices();
				const audioInputs = devices.filter((d) => d.kind === "audioinput");
				const audioOutputs = devices.filter((d) => d.kind === "audiooutput");

				setMics(audioInputs);
				setSpeakers(audioOutputs);

				if (!selectedMicId && audioInputs.length > 0) {
					setSelectedMicId(audioInputs[0].deviceId);
				}
				if (!selectedSpeakerId && audioOutputs.length > 0) {
					setSelectedSpeakerId(audioOutputs[0].deviceId);
				}
			} catch (err) {
				console.error("Failed to enumerate devices:", err);
			}
		};

		enumerateDevices();
		navigator.mediaDevices.addEventListener("devicechange", enumerateDevices);
		return () =>
			navigator.mediaDevices.removeEventListener(
				"devicechange",
				enumerateDevices,
			);
	}, [selectedMicId, selectedSpeakerId]);

	return {
		mics,
		speakers,
		selectedMic: mics.find((mic) => mic.deviceId === selectedMicId) ?? null,
		selectedSpeakerId,
		updateMic: setSelectedMicId,
		setSelectedSpeakerId,
	};
}
