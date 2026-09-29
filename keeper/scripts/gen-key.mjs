// Prints a fresh ed25519 key pair as JSON: {"public_key": "...", "private_key": "..."}.
import { KeyPair } from "near-api-js";

const key = KeyPair.fromRandom("ed25519");
console.log(JSON.stringify({ public_key: key.getPublicKey().toString(), private_key: key.toString() }));
