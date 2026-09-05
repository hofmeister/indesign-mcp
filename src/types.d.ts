// Asset imports embedded into the compiled binary (Bun `with { type: 'file' }`).
declare module '*.idml' {
  const path: string;
  export default path;
}
declare module '*.wasm' {
  const path: string;
  export default path;
}
declare module '*.ttf' {
  const path: string;
  export default path;
}
declare module '*.otf' {
  const path: string;
  export default path;
}
declare module '*.json?file' {
  const path: string;
  export default path;
}
declare module '*.rng' {
  const path: string;
  export default path;
}
