#!/usr/bin/env node
/** Project-local WondrStack binding and a sanitized snapshot from list_business_goals. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { publishProjectWrite } from "./hub-project-sync.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const ENDPOINT = "https://wondrstack.xyz/mcp";

function validSlug(value, label) {
  if (typeof value !== "string" || !SLUG.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

export function connectionPath(root, project) {
  return join(root, "sessions", "pstack", validSlug(project, "project slug"), "wondrstack.json");
}

export function loadWondrStack(project, { root = ROOT } = {}) {
  const path = connectionPath(root, project);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data.disconnected || data.project !== project || data.verifiedFrom !== "get_status" || !SLUG.test(data.workspace)) return null;
    return data;
  } catch {
    return null;
  }
}

function save(root, project, data) {
  const path = connectionPath(root, project);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  if (root === ROOT) publishProjectWrite(path, { root });
  return data;
}

function unwrapMcp(input) {
  let data = input;
  if (Array.isArray(data?.content)) data = data.content.find((part) => part?.type === "text")?.text;
  return typeof data === "string" ? JSON.parse(data) : data;
}

/** Bind only after comparing the authenticated get_status result with the expected workspace. */
export function connectWondrStack({ root = ROOT, project, status, expectedWorkspace }) {
  validSlug(project, "project slug");
  validSlug(expectedWorkspace, "expected workspace slug");
  const data = unwrapMcp(status);
  if (data?.isError || !data?.workspace || data.workspace.slug !== expectedWorkspace) {
    throw new Error("get_status workspace does not match the expected WondrStack workspace");
  }
  const workspace = data.workspace.slug;
  const previous = loadWondrStack(project, { root });
  const sameWorkspace = previous?.workspace === workspace;
  return save(root, project, {
    project,
    workspace,
    name: text(data.workspace.business_name, 120) || workspace,
    endpoint: ENDPOINT,
    verifiedFrom: "get_status",
    verifiedAt: new Date().toISOString(),
    appUrl: text(data.workspace.app_url, 300),
    repoUrl: text(data.workspace.code_repository, 300),
    linkedAt: sameWorkspace ? previous.linkedAt : new Date().toISOString(),
    ...(sameWorkspace && previous.goals ? { goals: previous.goals, syncedAt: previous.syncedAt } : {}),
  });
}

function text(value, max = 200) {
  return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().slice(0, max) : "";
}

function cents(value) {
  return Number.isSafeInteger(value) ? value : null;
}

/** MCP tool content may be a JSON object or {content:[{type:'text',text:'{...}'}]}. */
export function parseGoalSnapshot(input, workspace) {
  const data = unwrapMcp(input);
  if (!data || data.workspace !== workspace || !Array.isArray(data.goals)) {
    throw new Error("snapshot workspace does not match the linked WondrStack workspace");
  }
  if (data.goals.length > 50) throw new Error("too many goals in snapshot");
  return data.goals.map((goal) => {
    if (!goal || !/^[A-Z]{3}$/.test(goal.currency || "")) {
      throw new Error("invalid goal currency");
    }
    const actual = goal.latestActual;
    return {
      id: text(goal._id, 80),
      title: text(goal.title, 120),
      metric: text(goal.metric, 40),
      currency: goal.currency,
      targetCents: cents(goal.targetCents),
      periodStart: text(goal.periodStart, 10),
      periodEnd: text(goal.periodEnd, 10),
      status: text(goal.status, 30),
      planRoute: text(goal.plan?.route, 40),
      reviewDate: text(goal.plan?.reviewDate, 10),
      latestActual: actual && cents(actual.amountCents) !== null ? {
        amountCents: actual.amountCents,
        source: text(actual.source, 40),
        periodEnd: text(actual.periodEnd, 10),
      } : null,
      latestReviewAt: text(goal.latestReview?.recordedAt, 40),
    };
  });
}

export function syncWondrStackGoals({ root = ROOT, project, input }) {
  const binding = loadWondrStack(project, { root });
  if (!binding) throw new Error("WondrStack is not linked to this project");
  const goals = parseGoalSnapshot(input, binding.workspace);
  return save(root, project, { ...binding, goals, syncedAt: new Date().toISOString() });
}

export function disconnectWondrStack({ root = ROOT, project }) {
  const path = connectionPath(root, project);
  if (existsSync(path)) save(root, project, { project, disconnected: true, disconnectedAt: new Date().toISOString() });
}

function usage() {
  console.log(`gotchibot pstack wondrstack connect <project> <get_status-json-file> <expected-workspace-slug>
gotchibot pstack wondrstack sync <project> <list_business_goals-json-file>
gotchibot pstack wondrstack show <project>
gotchibot pstack wondrstack disconnect <project>

Run OpenClaw OAuth login and probe on the client's runtime, then save get_status MCP output before connect.
Only workspace identity and a sanitized goal snapshot are saved; OAuth credentials stay in OpenClaw.`);
}

if (isMainModule(import.meta.url)) {
  try {
    const [cmd, project, arg, ...rest] = process.argv.slice(2);
    if (!cmd || cmd === "--help" || cmd === "help") usage();
    else if (cmd === "connect") console.log(JSON.stringify(connectWondrStack({ project, status: JSON.parse(readFileSync(arg, "utf8")), expectedWorkspace: rest[0] }), null, 2));
    else if (cmd === "sync") console.log(JSON.stringify(syncWondrStackGoals({ project, input: JSON.parse(readFileSync(arg, "utf8")) }), null, 2));
    else if (cmd === "show") console.log(JSON.stringify(loadWondrStack(project), null, 2));
    else if (cmd === "disconnect") { disconnectWondrStack({ project }); console.log(`WondrStack unlinked from ${project}`); }
    else throw new Error(`unknown command: ${cmd}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
