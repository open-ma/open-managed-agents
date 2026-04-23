// Generates a real RSA-2048 keypair via Web Crypto and exports the private
// key as a PKCS#8 PEM. Used by GitHub provider tests so mintAppJwt() can
// actually sign — a fake PEM string would fail importKey() before any
// provider logic runs.

export async function generateTestPrivateKeyPem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  return pkcs8ToPem(new Uint8Array(pkcs8));
}

function pkcs8ToPem(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  // Wrap at 64 chars to mimic openssl's output format.
  const wrapped = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`;
}
