/** Files imported `with { type: "text" }`: their contents, embedded at build time. */
declare module "*.jsonl" {
  const text: string;
  export default text;
}
