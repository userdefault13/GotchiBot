/**
 * Where "the host" is, for scripts that a hero may run from INSIDE the OpenClaw
 * gateway container on the iMac.
 *
 * The trader API (:4000), subgraph proxy (:8787), mongo proxy (:8788), cartridge
 * sim (:8791) and trader webhook (:8792) all listen on the iMac host. From a
 * plain shell that is 127.0.0.1. From inside Docker, 127.0.0.1 is the container
 * itself, so LINK reported "the desk is down, API unreachable from the host"
 * while the desk was healthy the whole time. Docker Desktop (and the compose
 * file's host-gateway mapping on Linux) expose the host as host.docker.internal.
 *
 * An explicit env URL always wins; GOTCHIBOT_IN_DOCKER=1|0 forces detection.
 */
import { existsSync, readFileSync } from "node:fs";

export function inDocker() {
  const forced = process.env.GOTCHIBOT_IN_DOCKER;
  if (forced === "1") return true;
  if (forced === "0") return false;
  if (existsSync("/.dockerenv")) return true;
  try {
    return /docker|containerd|kubepods/.test(readFileSync("/proc/1/cgroup", "utf8"));
  } catch {
    return false;
  }
}

export function hostName() {
  return inDocker() ? "host.docker.internal" : "127.0.0.1";
}

/** http://<host>:<port><path> for a service that listens on the machine's loopback. */
export function hostServiceUrl(port, path = "") {
  return `http://${hostName()}:${port}${path}`;
}
