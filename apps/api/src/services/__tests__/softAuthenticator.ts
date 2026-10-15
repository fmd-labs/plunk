import {isoCBOR} from '@simplewebauthn/server/helpers';
import {createHash, generateKeyPairSync, randomBytes, sign} from 'node:crypto';

/**
 * A software passkey authenticator for tests (fork D39): it answers WebAuthn registration and authentication
 * options as a platform authenticator would, with an ES256 key, `none` attestation and a signature counter.
 */

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_DATA = 0x40;

export class SoftAuthenticator {
  private readonly keys = generateKeyPairSync('ec', {namedCurve: 'P-256'});
  public readonly credentialId = randomBytes(16);
  private counter = 0;

  constructor(
    private readonly origin: string,
    private readonly rpID: string,
    /** Whether the device verifies the user (biometrics or a PIN); a plain security key does not. */
    private readonly verifiesUser = true,
  ) {}

  private flags(extra = 0): number {
    return FLAG_USER_PRESENT | (this.verifiesUser ? FLAG_USER_VERIFIED : 0) | extra;
  }

  private counterBytes(): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(this.counter);
    return bytes;
  }

  private cosePublicKey(): Uint8Array {
    const jwk = this.keys.publicKey.export({format: 'jwk'});
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(JSON.stringify({type, challenge, origin: this.origin, crossOrigin: false}));
  }

  /** The answer to `navigator.credentials.create` for these options. */
  public register(options: {challenge: string}) {
    const credentialData = Buffer.concat([
      Buffer.alloc(16), // AAGUID: none
      Buffer.from([this.credentialId.length >> 8, this.credentialId.length & 0xff]),
      this.credentialId,
      this.cosePublicKey(),
    ]);
    const authData = Buffer.concat([
      sha256(this.rpID),
      Buffer.from([this.flags(FLAG_ATTESTED_DATA)]),
      this.counterBytes(),
      credentialData,
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Map<string, string> | Uint8Array>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, string>()],
        ['authData', authData],
      ]),
    );
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  /** The answer to `navigator.credentials.get` for these options. */
  public authenticate(options: {challenge: string}, userHandle?: string) {
    this.counter += 1;
    const authData = Buffer.concat([sha256(this.rpID), Buffer.from([this.flags()]), this.counterBytes()]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.keys.privateKey);
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        ...(userHandle ? {userHandle: b64url(Buffer.from(userHandle))} : {}),
      },
      clientExtensionResults: {},
    };
  }
}
