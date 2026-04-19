export interface PlaygroundContent {
  gravity?: readonly number[];
  clearColor?: readonly number[];
}

export interface PlaygroundData {
  engine: string;
  version: number;
  code?: string;
  main?: string;
  playgroundContent?: PlaygroundContent;
}
