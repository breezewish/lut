import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const fixturePath =
  process.env.RAW_LARGE_FIXTURE_PATH ?? "/tmp/raw-alchemy-ilce-7rm4-61mp.ARW";
const expectedSha256 =
  "e6dafe42643f69ab9d1fd00414b7a1f5104df354bb589201600ac934b29b5e4a";
const fixtureUrl =
  "https://raw.pixls.us/getfile.php/3480/nice/Sony%20-%20ILCE-7RM4%20-%2014bit%2014bit%20compressed%20(3:2).ARW";

let bytes;
try {
  bytes = await readFile(fixturePath);
} catch (error) {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== "ENOENT"
  ) {
    throw error;
  }
}

if (!bytes || sha256(bytes) !== expectedSha256) {
  const response = await fetch(fixtureUrl);
  if (!response.ok) {
    throw new Error(
      `Could not download the 61 MP RAW fixture: HTTP ${response.status}.`,
    );
  }
  bytes = Buffer.from(await response.arrayBuffer());
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `The 61 MP RAW fixture checksum is ${actualSha256}, expected ${expectedSha256}.`,
    );
  }
  await writeFile(fixturePath, bytes);
}

console.log(`61 MP RAW fixture ready: ${fixturePath}`);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
