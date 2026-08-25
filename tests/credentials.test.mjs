import assert from "node:assert/strict";
import test from "node:test";

// A fixed 32-byte key so failures are reproducible. This is test-only material;
// production reads GRIDLINE_CREDENTIAL_KEY from the deployment secret.
const KEY = Buffer.alloc(32, 7).toString("base64");
process.env.GRIDLINE_CREDENTIAL_KEY = KEY;

const { encryptCredentials, decryptCredentials, credentialsConfigured, maskUsername, CredentialError } =
  await import("../lib/credentials.ts");

test("credentials survive a round trip", async () => {
  const stored = await encryptCredentials("owner@example.com", "correct horse battery staple");
  assert.ok(stored.encryptedUsername.length > 0);
  assert.ok(stored.encryptedPassword.length > 0);

  const plain = await decryptCredentials(stored);
  assert.deepEqual(plain, { username: "owner@example.com", password: "correct horse battery staple" });
});

test("ciphertext never contains the plaintext and each field gets its own IV", async () => {
  const stored = await encryptCredentials("owner@example.com", "owner@example.com");
  const [usernameIv, passwordIv] = stored.credentialIv.split(":");

  assert.notEqual(usernameIv, passwordIv, "reusing one IV for both fields leaks their XOR under GCM");
  // Identical plaintexts under different IVs must produce different ciphertext.
  assert.notEqual(stored.encryptedUsername, stored.encryptedPassword);
  assert.ok(!stored.encryptedUsername.includes("owner"));
});

test("encrypting the same value twice never repeats a ciphertext", async () => {
  const a = await encryptCredentials("owner@example.com", "hunter2");
  const b = await encryptCredentials("owner@example.com", "hunter2");
  assert.notEqual(a.encryptedPassword, b.encryptedPassword);
  assert.notEqual(a.credentialIv, b.credentialIv);
});

test("a tampered ciphertext is rejected rather than silently decrypted", async () => {
  const stored = await encryptCredentials("owner@example.com", "hunter2");
  const bytes = Buffer.from(stored.encryptedPassword, "base64");
  bytes[0] ^= 0xff;
  await assert.rejects(
    () => decryptCredentials({ ...stored, encryptedPassword: bytes.toString("base64") }),
    (error) => error instanceof CredentialError,
  );
});

test("a different key cannot read the record", async () => {
  const stored = await encryptCredentials("owner@example.com", "hunter2");
  process.env.GRIDLINE_CREDENTIAL_KEY = Buffer.alloc(32, 9).toString("base64");
  await assert.rejects(() => decryptCredentials(stored), (error) => error instanceof CredentialError);
  process.env.GRIDLINE_CREDENTIAL_KEY = KEY;
});

test("a missing or malformed key fails loudly", async () => {
  delete process.env.GRIDLINE_CREDENTIAL_KEY;
  assert.equal(credentialsConfigured(), false);
  await assert.rejects(() => encryptCredentials("a", "b"), (error) => error instanceof CredentialError);

  process.env.GRIDLINE_CREDENTIAL_KEY = Buffer.alloc(16, 1).toString("base64");
  await assert.rejects(() => encryptCredentials("a", "b"), (error) => /32 bytes/.test(error.message));

  process.env.GRIDLINE_CREDENTIAL_KEY = KEY;
  assert.equal(credentialsConfigured(), true);
});

test("a row with no stored credentials decrypts to null rather than throwing", async () => {
  assert.equal(await decryptCredentials(null), null);
  assert.equal(await decryptCredentials({ encryptedUsername: "x" }), null);
});

test("usernames are masked for display", () => {
  assert.equal(maskUsername("owner1234@example.com"), "own••••••@example.com");
  assert.equal(maskUsername("ab@x.com"), "ab•••@x.com");
  assert.equal(maskUsername("plainuser"), "pla••••••");
});
