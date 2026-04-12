export interface ManagedAudioSound {
    play(): void;
    stop(): void;
    dispose(): void;
    setVolume(volume: number): void;
    getVolume(): number;
    isActive(): boolean;
}

export function fromAbstractSound(sound: BABYLON.AbstractSound): ManagedAudioSound {
    return {
        play: () => sound.play(),
        stop: () => sound.stop(),
        dispose: () => sound.dispose(),
        setVolume: (volume: number) => sound.setVolume(volume),
        getVolume: () => sound.volume,
        isActive: () => sound.activeInstancesCount > 0
    };
}

export function fromLegacySound(sound: BABYLON.Sound): ManagedAudioSound {
    return {
        play: () => sound.play(),
        stop: () => sound.stop(),
        dispose: () => sound.dispose(),
        setVolume: (volume: number) => sound.setVolume(volume),
        getVolume: () => sound.getVolume(),
        isActive: () => sound.isPlaying
    };
}