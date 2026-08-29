import { argon2id } from "hash-wasm";

const saltHex = "05a922b8b45dfe4ec265b4d4466c064a";
const salt = Uint8Array.from(Buffer.from(saltHex, "hex"));
const passphrase = "correct horse battery staple test 2026";

const hash = await argon2id({
  password: passphrase,
  salt,
  parallelism: 4,
  iterations: 3,
  memorySize: 262144, // KiB
  hashLength: 32,
  outputType: "hex",
});

console.log("JS  argon2id master_key hex:", hash);
console.log("PY  argon2id master_key hex: ad27f054e7962643b7a72231f9633e268268f455935b0e9bc3cf4ecfe93ab605");
console.log("MATCH:", hash === "ad27f054e7962643b7a72231f9633e268268f455935b0e9bc3cf4ecfe93ab605");
