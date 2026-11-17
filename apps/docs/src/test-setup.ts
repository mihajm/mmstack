// happy-dom's Response has no bytes(), which shiki's wasm loader calls.
const proto = Response.prototype as Response & {
  bytes?: () => Promise<Uint8Array>;
};
proto.bytes ??= async function (this: Response) {
  return new Uint8Array(await this.arrayBuffer());
};
