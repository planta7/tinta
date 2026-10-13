export const workerCode: string;
export const previewHtml: string;
export const examples: Readonly<Record<string, string>>;
export const exampleAssets: Readonly<
  Record<string, readonly { path: string; base64: string }[]>
>;
export const snippets: Readonly<Record<string, string>>;
export const studioVersion: string;

export declare const studioBuild: string;
