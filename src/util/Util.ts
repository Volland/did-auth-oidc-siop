import SHA from "sha.js";
import base58 from "bs58";
import { ec as EC } from "elliptic";
import { JWK, jwtVerify, importJWK } from "jose";
import base64url from "base64url";
import EthrDidResolver from "ethr-did-resolver";
import { resolver as didKeyResolver } from "@transmute/did-key.js";
import { decodeJWT, JWTPayload, JWTHeader } from "did-jwt";
import { EcdsaSignature } from "did-jwt/lib/util";
import {
  DIDDocument,
  Resolver,
  VerificationMethod,
  DIDResolutionResult,
} from "did-resolver";
import axios, { AxiosResponse } from "axios";
import { ethers, utils } from "ethers";
import { keyUtils } from "@transmute/did-key-ed25519";

import { DidAuthErrors } from "../interfaces";
import {
  DidAuthKeyAlgorithm,
  DidAuthRequestPayload,
  DidAuthResponseIss,
  DidAuthResponsePayload,
  InternalVerification,
  RegistrationJwksUri,
} from "../interfaces/DIDAuth.types";
// eslint-disable-next-line import/no-cycle
import { getPublicJWKFromPublicHex } from "./JWK";

export const prefixWith0x = (key: string): string =>
  key.startsWith("0x") ? key : `0x${key}`;

const fromBase64 = (base64: string) =>
  base64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

const base64urlEncodeBuffer = (buf: {
  toString: (arg0: "base64") => string;
}): string => fromBase64(buf.toString("base64"));

function getNonce(input: string): string {
  const buff = SHA("sha256").update(input).digest();
  return base64urlEncodeBuffer(buff);
}

function getState(): string {
  const randomNumber = ethers.BigNumber.from(utils.randomBytes(12));
  return utils.hexlify(randomNumber).replace("0x", "");
}

function toHex(data: string): string {
  return Buffer.from(data, "base64").toString("hex");
}

function isHex(str) {
  const re = /[0-9A-Fa-f]{6}/g;
  return re.test(str);
}

function getEthWallet(key: JWK): ethers.Wallet {
  return new ethers.Wallet(prefixWith0x(toHex(key.d)));
}

function getHexPrivateKey(key: JWK): string {
  return getEthWallet(key).privateKey;
}

function getEthAddress(key: JWK): string {
  return getEthWallet(key).address;
}

function getDIDFromKey(key: JWK): string {
  return `did:ethr:${getEthAddress(key)}`;
}

async function doPostCallWithToken(
  url: string,
  data: unknown,
  token: string
): Promise<AxiosResponse> {
  const conf = {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
  try {
    const response = await axios.post(url, data, conf);
    return response;
  } catch (error) {
    throw new Error(
      `${DidAuthErrors.ERROR_ON_POST_CALL}${(error as Error).message}`
    );
  }
}

const getAudience = (jwt: string): string | undefined => {
  const { payload } = decodeJWT(jwt);
  if (!payload) throw new Error(DidAuthErrors.NO_AUDIENCE);
  if (!payload.aud) return undefined;
  if (Array.isArray(payload.aud))
    throw new Error(DidAuthErrors.INVALID_AUDIENCE);
  return payload.aud;
};

const getIssuerDid = (jwt: string): string => {
  const { payload } = decodeJWT(jwt);
  if (!payload || !payload.iss) throw new Error(DidAuthErrors.NO_ISS_DID);
  if (payload.iss === DidAuthResponseIss.SELF_ISSUE)
    return (payload as DidAuthResponsePayload).did;
  return payload.iss;
};

const parseJWT = (jwt: string): { payload: JWTPayload; header: JWTHeader } => {
  const { payload, header } = decodeJWT(jwt);
  if (!payload || !header) throw new Error(DidAuthErrors.NO_ISS_DID);
  return { payload, header };
};
const getNetworkFromDid = (did: string): string => {
  const network = "mainnet"; // default
  const splitDidFormat = did.split(":");
  if (splitDidFormat.length === 4) {
    return splitDidFormat[2];
  }
  if (splitDidFormat.length > 4) {
    return `${splitDidFormat[2]}:${splitDidFormat[3]}`;
  }
  return network;
};

const resolveDid = async (
  did: string,
  didUrlResolver: string
): Promise<DIDResolutionResult> => {
  const response = await axios.get(
    `${didUrlResolver}/${did};transform-keys=jwks`
  );
  const didDocument = response.data as DIDDocument;
  return {
    didResolutionMetadata: {},
    didDocument,
    didDocumentMetadata: {},
  } as DIDResolutionResult;
};

const resolveDidKey = async (did: string): Promise<DIDResolutionResult> =>
  (await didKeyResolver.resolve(did)) as DIDResolutionResult;

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
const getResolver = (didUrlResolver: string) => {
  async function resolve(did: string) {
    return resolveDid(did, didUrlResolver);
  }

  return { ethr: resolve };
};

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
const getResolverDidKey = () => {
  async function resolve(did: string) {
    return resolveDidKey(did);
  }

  return { key: resolve };
};

const isKeyDid = (did: string): boolean => {
  if (!did) return false;
  if (did.match(/^did:key:/g)) return true;
  return false;
};

const getUrlResolver = async (
  jwt: string,
  internalVerification: InternalVerification
): Promise<Resolver> => {
  const did = getIssuerDid(jwt);
  try {
    if (!internalVerification.didUrlResolver)
      throw new Error(DidAuthErrors.BAD_INTERNAL_VERIFICATION_PARAMS);
    // check if the token issuer DID can be resolved
    await axios.get(`${internalVerification.didUrlResolver}/${did}`);

    return isKeyDid(did)
      ? new Resolver(getResolverDidKey())
      : new Resolver(getResolver(internalVerification.didUrlResolver));
  } catch (error) {
    if (!internalVerification.registry || !internalVerification.rpcUrl)
      throw new Error(DidAuthErrors.BAD_INTERNAL_VERIFICATION_PARAMS);
    return new Resolver(
      EthrDidResolver.getResolver({
        networks: [
          {
            // TODO: Be able to understand in case did has chainId instead of name
            name: getNetworkFromDid(did),
            rpcUrl: internalVerification.rpcUrl,
            registry: internalVerification.registry,
          },
        ],
      })
    );
  }
};

const hasJwksUri = (payload: DidAuthRequestPayload): boolean => {
  if (!payload) return false;
  if (
    !payload.registration ||
    !(payload.registration as RegistrationJwksUri).jwks_uri
  )
    return false;
  return true;
};

const DidMatchFromJwksUri = (
  payload: DidAuthRequestPayload,
  issuerDid: string
): boolean => {
  const jwksUri = (payload.registration as RegistrationJwksUri).jwks_uri;
  return jwksUri.includes(issuerDid);
};

const compareKidWithId = (kid: string, elem: VerificationMethod): boolean => {
  // kid can be "kid": "H7j7N4Phx2U1JQZ2SBjczz2omRjnMgT8c2gjDBv2Bf0="
  // or "did:ethr:0x0106a2e985b1E1De9B5ddb4aF6dC9e928F4e99D0#keys-1
  if (kid.includes("did:") || kid.startsWith("#")) {
    return elem.id === kid;
  }
  return elem.id.split("#")[1] === kid;
};

const getVerificationMethod = (
  kid: string,
  didDoc: DIDDocument
): VerificationMethod => {
  if (
    !didDoc ||
    !didDoc.verificationMethod ||
    didDoc.verificationMethod.length < 1
  )
    throw new Error(DidAuthErrors.ERROR_RETRIEVING_VERIFICATION_METHOD);
  const { verificationMethod } = didDoc;
  // Get the kid from the publicKeyJwk, if it does not exist (verifyDidAuthRequest) compare with the id
  return verificationMethod.find((elem) =>
    elem.publicKeyJwk
      ? elem.publicKeyJwk.kid === kid
      : compareKidWithId(kid, elem)
  );
};

const extractPublicKeyJwk = (vm: VerificationMethod): JWK => {
  if (vm.publicKeyJwk) {
    return vm.publicKeyJwk;
  }
  if (vm.publicKeyBase58) {
    return getPublicJWKFromPublicHex(
      base58.decode(vm.publicKeyBase58).toString("hex")
    );
  }

  throw new Error("No public key found!");
};

const extractPublicKeyBytes = (
  vm: VerificationMethod
): string | { x: string; y: string } => {
  if (vm.publicKeyBase58) {
    return base58.decode(vm.publicKeyBase58).toString("hex");
  }

  if (vm.publicKeyJwk) {
    return {
      x: isHex(vm.publicKeyJwk.x)
        ? vm.publicKeyJwk.x
        : toHex(vm.publicKeyJwk.x),
      y: isHex(vm.publicKeyJwk.x)
        ? vm.publicKeyJwk.y
        : toHex(vm.publicKeyJwk.y),
    };
  }
  throw new Error("No public key found!");
};

function toSignatureObject(signature: string): EcdsaSignature {
  const rawsig: Buffer = base64url.toBuffer(signature);
  if (rawsig.length !== 64 && rawsig.length !== 65) {
    throw new Error("wrong signature length");
  }

  const r: string = rawsig.slice(0, 32).toString("hex");
  const s: string = rawsig.slice(32, 64).toString("hex");
  const sigObj: EcdsaSignature = { r, s };

  return sigObj;
}

const verifyES256K = async (
  jwt: string,
  verificationMethod: VerificationMethod
): Promise<boolean> => {
  const publicKey = extractPublicKeyJwk(verificationMethod);
  const result = await jwtVerify(
    jwt,
    await importJWK(publicKey, DidAuthKeyAlgorithm.ES256K)
  );
  if (!result || !result.payload)
    throw Error(DidAuthErrors.ERROR_VERIFYING_SIGNATURE);
  return true;
};

const verifyES256KR = (
  jwt: string,
  verificationMethod: VerificationMethod
): boolean => {
  const publicKey = extractPublicKeyBytes(verificationMethod);
  const secp256k1 = new EC("secp256k1");
  const { data, signature } = decodeJWT(jwt);
  const hash = SHA("sha256").update(data).digest();
  const sigObj = toSignatureObject(signature);
  return secp256k1.keyFromPublic(publicKey, "hex").verify(hash, sigObj);
};
const verifyEDDSA = async (
  jwt: string,
  verificationMethod: VerificationMethod
): Promise<boolean> => {
  let publicKey: JWK;
  if (verificationMethod.publicKeyBase58)
    publicKey = keyUtils.publicKeyJwkFromPublicKeyBase58(
      verificationMethod.publicKeyBase58
    );
  if (verificationMethod.publicKeyJwk)
    publicKey = verificationMethod.publicKeyJwk;
  const result = await jwtVerify(
    jwt,
    await importJWK(publicKey, DidAuthKeyAlgorithm.EDDSA)
  );
  if (!result || !result.payload)
    throw Error(DidAuthErrors.ERROR_VERIFYING_SIGNATURE);
  return true;
};

const verifySignatureFromVerificationMethod = async (
  jwt: string,
  verificationMethod: VerificationMethod
): Promise<boolean> => {
  const { header } = decodeJWT(jwt);
  if (header.alg === DidAuthKeyAlgorithm.EDDSA)
    return verifyEDDSA(jwt, verificationMethod);
  if (header.alg === DidAuthKeyAlgorithm.ES256K)
    return verifyES256K(jwt, verificationMethod);
  if (header.alg === DidAuthKeyAlgorithm.ES256KR)
    return verifyES256KR(jwt, verificationMethod);
  return false;
};

export {
  getNonce,
  getState,
  hasJwksUri,
  getAudience,
  getIssuerDid,
  parseJWT,
  getDIDFromKey,
  getUrlResolver,
  getHexPrivateKey,
  DidMatchFromJwksUri,
  doPostCallWithToken,
  base64urlEncodeBuffer,
  getVerificationMethod,
  verifySignatureFromVerificationMethod,
  getNetworkFromDid,
  extractPublicKeyBytes,
  extractPublicKeyJwk,
  resolveDid,
};
