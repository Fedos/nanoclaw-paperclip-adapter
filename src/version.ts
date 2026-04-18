declare const __PACKAGE_VERSION__: string | undefined;

export const PACKAGE_VERSION: string =
  typeof __PACKAGE_VERSION__ === "string" && __PACKAGE_VERSION__.length > 0
    ? __PACKAGE_VERSION__
    : "0.0.0-dev";

export const USER_AGENT = `nanoclaw-paperclip-adapter/${PACKAGE_VERSION}`;
