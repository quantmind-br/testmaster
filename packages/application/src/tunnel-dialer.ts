import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { type AuthorizedTarget, classifyIp, PolicyDenied } from "@testmaster/sandbox";
import type { RemoteWorkerTransport } from "./remote-worker-agent.js";
import { certificateFingerprint } from "./tunnel-certificate.js";
import type { TunnelDispatch } from "./tunnels.js";

/**
 * The egress dialer of a tunnelled remote Attempt (ADR-031). The tunnel's target is reached
 * through the relay, inside TLS to the agent whose certificate fingerprint the dispatch pins, so
 * the relay forwards only ciphertext. Any other loopback destination is refused, so the worker's
 * own loopback is never reached; every other target is left to the proxy's direct connection.
 */
export function tunnelDialer(options: {
  transport: RemoteWorkerTransport;
  /** The worker route that upgrades to one stream of the Attempt's tunnel. */
  path: string;
  tunnel: TunnelDispatch;
}): (target: AuthorizedTarget) => Promise<Socket | null> {
  const { address, port } = options.tunnel.target;
  return async (target) => {
    if (target.pinnedIp !== address || target.port !== port) {
      if (classifyIp(target.pinnedIp) === "loopback")
        throw new PolicyDenied("tunnel_target_mismatch");
      return null;
    }
    let raw: Duplex;
    try {
      raw = await options.transport.openStream(options.path);
    } catch {
      throw new PolicyDenied("tunnel_unavailable");
    }
    const { promise, resolve, reject } = Promise.withResolvers<Socket>();
    // The agent's certificate is self-signed for this session: the pinned fingerprint is the trust.
    const secure = tlsConnect({ socket: raw, rejectUnauthorized: false, minVersion: "TLSv1.3" });
    secure.once("secureConnect", () => {
      const presented = secure.getPeerCertificate().raw;
      if (!presented || certificateFingerprint(presented) !== options.tunnel.certificateSha256) {
        secure.destroy();
        reject(new PolicyDenied("tunnel_certificate_mismatch"));
        return;
      }
      resolve(secure);
    });
    secure.once("error", () => {
      secure.destroy();
      reject(new PolicyDenied("tunnel_unavailable"));
    });
    return promise;
  };
}
