export interface PlaygroundContent extends Record<string, unknown> {
    gravity?: readonly number[];
    clearColor?: readonly number[];
}

export interface PlaygroundData extends Record<string, unknown> {
    engine: string;
    version: number;
    code?: string;
    main?: string;
    playgroundContent?: PlaygroundContent;
}