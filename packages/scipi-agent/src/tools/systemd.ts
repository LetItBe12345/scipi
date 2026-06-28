import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { $which, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { buildNonInteractiveEnv } from "../exec/non-interactive-env";
import systemdDescription from "../prompts/tools/systemd.md" with { type: "text" };
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { formatPathRelativeToCwd, resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const SYSTEMD_READONLY_OPS: Record<string, true> = { list: true, status: true, logs: true };
const SYSTEMD_TOOL_UNIT_PREFIX = "omp-";
const SYSTEMD_TOOL_UNIT_SUFFIX = ".service";
const SYSTEMD_TOOL_MANAGED_ENV = "OMP_MANAGED_BY=oh-my-pi-systemd";
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNIT_STEM_PATTERN = /^[A-Za-z0-9:_-]+$/;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_LOG_LINES = 100;
const MAX_LOG_LINES = 500;
const STOP_REFRESH_ATTEMPTS = 8;
const STOP_REFRESH_DELAY_MS = 250;
const SYSTEMD_SHOW_PROPERTIES = [
	"Id",
	"Description",
	"LoadState",
	"ActiveState",
	"SubState",
	"Result",
	"ExecMainPID",
	"ExecMainCode",
	"ExecMainStatus",
	"MainPID",
	"MemoryCurrent",
	"CPUUsageNSec",
	"FragmentPath",
	"InvocationID",
	"ActiveEnterTimestamp",
	"ActiveExitTimestamp",
	"StateChangeTimestamp",
	"UnitFileState",
	"Environment",
] as const;

const systemdSchema = type({
	op: type("'submit' | 'status' | 'logs' | 'stop' | 'list'").describe("systemd operation"),
	"unit?": type("string").describe("managed unit name or short alias"),
	"command?": type("string").describe("shell command to run under systemd-run --user"),
	"cwd?": type("string").describe("working directory for submit"),
	"env?": type("Record<string, string>").describe("environment variables for submit"),
	"memory?": type("string").describe("MemoryMax value, e.g. 16G"),
	"cpuQuota?": type("string").describe("CPUQuota value, e.g. 200%"),
	"gpu?": type("string").describe("visible GPU selector, e.g. all, none, 0, or 0,1"),
	"lines?": type("number").describe("journal lines to return for logs"),
	"description?": type("string").describe("systemd unit description for submit"),
	"remainAfterExit?": type("boolean").describe("keep the transient unit active after the command exits"),
});

export type SystemdParams = typeof systemdSchema.infer;
export type SystemdOp = SystemdParams["op"];

export interface SystemdCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface SystemdUnitSnapshot {
	unit: string;
	description?: string;
	loadState?: string;
	activeState?: string;
	subState?: string;
	result?: string;
	execMainPid?: number;
	execMainCode?: string;
	execMainStatus?: number;
	memoryCurrent?: number;
	cpuUsageNSec?: number;
	fragmentPath?: string;
	invocationId?: string;
	activeEnterTimestamp?: string;
	activeExitTimestamp?: string;
	stateChangeTimestamp?: string;
	unitFileState?: string;
}
interface ParsedUnitStatus {
	snapshot: SystemdUnitSnapshot;
	environment?: string;
}

export interface SystemdToolDetails {
	op: SystemdOp;
	unit?: string;
	units?: SystemdUnitSnapshot[];
	command?: string;
	cwd?: string;
	lines?: number;
}

export type SystemdCommandRunner = (
	args: readonly string[],
	options: { cwd: string; signal?: AbortSignal; env?: Record<string, string> },
) => Promise<SystemdCommandResult>;

interface SystemdToolOptions {
	runCommand?: SystemdCommandRunner;
	hasCommand?: (command: string) => boolean;
	platform?: NodeJS.Platform;
	now?: () => Date;
	randomSuffix?: () => string;
}


async function defaultRunCommand(
	args: readonly string[],
	options: { cwd: string; signal?: AbortSignal; env?: Record<string, string> },
): Promise<SystemdCommandResult> {
	const timeoutSignal = AbortSignal.timeout(DEFAULT_COMMAND_TIMEOUT_MS);
	const combinedSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	try {
		const child = Bun.spawn(args, {
			cwd: options.cwd,
			env: buildNonInteractiveEnv(options.env),
			signal: combinedSignal,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		if (!child.stdout || !child.stderr) {
			throw new ToolError(`Failed to capture ${args[0]} output.`);
		}
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { exitCode: exitCode ?? 0, stdout, stderr };
	} catch (error) {
		if (timeoutSignal.aborted && !options.signal?.aborted) {
			throw new ToolError(`${args[0]} timed out after ${Math.floor(DEFAULT_COMMAND_TIMEOUT_MS / 1000)} seconds`);
		}
		throw error;
	}
}

function getObjectStringField(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object" || !(key in value)) return undefined;
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function normalizeEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!env || Object.keys(env).length === 0) return undefined;
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!ENV_NAME_PATTERN.test(key)) {
			throw new ToolError(`Invalid systemd env name: ${key}`);
		}
		normalized[key] = value;
	}
	return normalized;
}

function normalizeNonEmpty(value: string | undefined, label: string): string {
	const normalized = value?.trim();
	if (!normalized) {
		throw new ToolError(`${label} is required`);
	}
	return normalized;
}

function normalizeOptionalValue(value: string | undefined, label: string): string | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (!normalized) {
		throw new ToolError(`${label} must not be empty`);
	}
	return normalized;
}

function normalizeLogLines(value: number | undefined): number {
	if (value === undefined) return DEFAULT_LOG_LINES;
	if (!Number.isFinite(value) || value <= 0) {
		throw new ToolError("lines must be a positive number");
	}
	return Math.min(MAX_LOG_LINES, Math.floor(value));
}

function normalizeManagedUnitName(raw: string): string {
	const input = normalizeNonEmpty(raw, "unit");
	const hasSuffix = input.endsWith(SYSTEMD_TOOL_UNIT_SUFFIX);
	const stem = hasSuffix ? input.slice(0, -SYSTEMD_TOOL_UNIT_SUFFIX.length) : input;
	const managedStem = stem.startsWith(SYSTEMD_TOOL_UNIT_PREFIX) ? stem : `${SYSTEMD_TOOL_UNIT_PREFIX}${stem}`;
	if (!managedStem.startsWith(SYSTEMD_TOOL_UNIT_PREFIX)) {
		throw new ToolError(`systemd tool only manages ${SYSTEMD_TOOL_UNIT_PREFIX}*.service units`);
	}
	if (!UNIT_STEM_PATTERN.test(managedStem)) {
		throw new ToolError(
			`Invalid unit name: ${raw}. Use letters, digits, colon, underscore, or hyphen only.`,
		);
	}
	if (hasSuffix && !stem.startsWith(SYSTEMD_TOOL_UNIT_PREFIX)) {
		throw new ToolError(`systemd tool only manages ${SYSTEMD_TOOL_UNIT_PREFIX}*.service units`);
	}
	return `${managedStem}${SYSTEMD_TOOL_UNIT_SUFFIX}`;
}

function generateManagedUnitName(now: Date, randomSuffix: string): string {
	const pad = (value: number) => value.toString().padStart(2, "0");
	const timestamp = [
		now.getFullYear().toString(),
		pad(now.getMonth() + 1),
		pad(now.getDate()),
		"-",
		pad(now.getHours()),
		pad(now.getMinutes()),
		pad(now.getSeconds()),
	].join("");
	const suffix = randomSuffix.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 6) || "unit";
	return `${SYSTEMD_TOOL_UNIT_PREFIX}${timestamp}-${suffix}${SYSTEMD_TOOL_UNIT_SUFFIX}`;
}

function parseShowProperties(stdout: string): Record<string, string> {
	const properties: Record<string, string> = {};
	for (const line of stdout.split(/\r?\n/u)) {
		if (!line) continue;
		const separator = line.indexOf("=");
		if (separator === -1) continue;
		properties[line.slice(0, separator)] = line.slice(separator + 1);
	}
	return properties;
}

function parseOptionalInt(value: string | undefined): number | undefined {
	if (!value || value === "[not set]") return undefined;
	if (!/^\d+$/u.test(value)) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseUnitStatus(stdout: string): ParsedUnitStatus {
	const props = parseShowProperties(stdout);
	return {
		snapshot: {
			unit: props.Id ?? "",
			description: props.Description || undefined,
			loadState: props.LoadState || undefined,
			activeState: props.ActiveState || undefined,
			subState: props.SubState || undefined,
			result: props.Result || undefined,
			execMainPid: parseOptionalInt(props.ExecMainPID) || parseOptionalInt(props.MainPID),
			execMainCode: props.ExecMainCode || undefined,
			execMainStatus: parseOptionalInt(props.ExecMainStatus),
			memoryCurrent: parseOptionalInt(props.MemoryCurrent),
			cpuUsageNSec: parseOptionalInt(props.CPUUsageNSec),
			fragmentPath: props.FragmentPath || undefined,
			invocationId: props.InvocationID || undefined,
			activeEnterTimestamp: props.ActiveEnterTimestamp || undefined,
			activeExitTimestamp: props.ActiveExitTimestamp || undefined,
			stateChangeTimestamp: props.StateChangeTimestamp || undefined,
			unitFileState: props.UnitFileState || undefined,
		},
		environment: props.Environment || undefined,
	};
}

function hasManagedEnvironment(environment: string | undefined): boolean {
	if (!environment) return false;
	return /(^|\s)OMP_MANAGED_BY=oh-my-pi-systemd(\s|$)/u.test(environment);
}

function isStoppedUnitSnapshot(snapshot: SystemdUnitSnapshot): boolean {
	return snapshot.activeState === "inactive" && snapshot.subState === "dead";
}

function isMissingUnitMessage(message: string): boolean {
	return /could not be found|not loaded|Unable to read status/u.test(message);
}

function parseListUnits(stdout: string): SystemdUnitSnapshot[] {
	const units: SystemdUnitSnapshot[] = [];
	for (const line of stdout.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const match = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/u.exec(trimmed);
		if (!match) continue;
		units.push({
			unit: match[1]!,
			loadState: match[2]!,
			activeState: match[3]!,
			subState: match[4]!,
			description: match[5] || undefined,
		});
	}
	return units;
}

function formatCpuUsage(cpuUsageNSec: number | undefined): string | undefined {
	if (cpuUsageNSec === undefined) return undefined;
	return `${(cpuUsageNSec / 1_000_000_000).toFixed(2)}s`;
}

function previewCommand(command: string): string {
	return truncateForPrompt(command).replaceAll("\n", " ");
}

function formatUnitSnapshot(snapshot: SystemdUnitSnapshot, session: ToolSession): string[] {
	const lines = [
		`Unit: ${snapshot.unit}`,
		`State: ${snapshot.activeState ?? "unknown"}${snapshot.subState ? ` (${snapshot.subState})` : ""}`,
	];
	if (snapshot.loadState) lines.push(`Load: ${snapshot.loadState}`);
	if (snapshot.description) lines.push(`Description: ${snapshot.description}`);
	if (snapshot.result) lines.push(`Result: ${snapshot.result}`);
	if (snapshot.execMainPid !== undefined && snapshot.execMainPid > 0) lines.push(`PID: ${snapshot.execMainPid}`);
	if (snapshot.execMainCode || snapshot.execMainStatus !== undefined) {
		lines.push(
			`Exit: ${snapshot.execMainCode ?? "status"}${snapshot.execMainStatus !== undefined ? ` ${snapshot.execMainStatus}` : ""}`,
		);
	}
	if (snapshot.memoryCurrent !== undefined) lines.push(`MemoryCurrent: ${snapshot.memoryCurrent}`);
	const cpuUsage = formatCpuUsage(snapshot.cpuUsageNSec);
	if (cpuUsage) lines.push(`CPU: ${cpuUsage}`);
	if (snapshot.unitFileState) lines.push(`UnitFileState: ${snapshot.unitFileState}`);
	if (snapshot.fragmentPath) lines.push(`Fragment: ${formatPathRelativeToCwd(snapshot.fragmentPath, session.cwd)}`);
	if (snapshot.activeEnterTimestamp) lines.push(`ActiveSince: ${snapshot.activeEnterTimestamp}`);
	if (snapshot.activeExitTimestamp) lines.push(`InactiveSince: ${snapshot.activeExitTimestamp}`);
	if (snapshot.stateChangeTimestamp) lines.push(`StateChanged: ${snapshot.stateChangeTimestamp}`);
	return lines;
}

function buildManagedDescription(command: string, explicitDescription: string | undefined): string {
	if (explicitDescription) return explicitDescription;
	return `oh-my-pi: ${previewCommand(command)}`;
}

function systemdFailureMessage(result: SystemdCommandResult): string {
	const stderr = result.stderr.trim();
	if (stderr) return stderr;
	const stdout = result.stdout.trim();
	if (stdout) return stdout;
	return `systemd command failed with exit code ${result.exitCode}`;
}

function assertAllowedFields(params: SystemdParams, allowed: readonly (keyof SystemdParams)[]): void {
	const allowedFields = ["op", ...allowed];
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined) continue;
		if (!allowedFields.some(entry => entry === key)) {
			throw new ToolError(`\`${key}\` is not valid for op ${params.op}`);
		}
	}
}

export class SystemdTool implements AgentTool<typeof systemdSchema, SystemdToolDetails> {
	readonly name = "systemd";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const op = getObjectStringField(args, "op")?.toLowerCase() ?? "";
		return SYSTEMD_READONLY_OPS[op] ? "read" : "exec";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const op = getObjectStringField(args, "op");
		const unit = getObjectStringField(args, "unit");
		const command = getObjectStringField(args, "command");
		const cwd = getObjectStringField(args, "cwd");
		const lines = [`Op: ${op ?? "(missing)"}`];
		if (unit?.trim()) lines.push(`Unit: ${unit.trim()}`);
		if (command?.trim()) lines.push(`Command: ${previewCommand(command)}`);
		if (cwd?.trim()) lines.push(`Cwd: ${cwd.trim()}`);
		return lines;
	};
	readonly summary = "Submit and manage persistent systemd --user services for long-running local jobs";
	readonly loadMode = "discoverable";
	readonly label = "Systemd";
	readonly description = prompt.render(systemdDescription);
	readonly parameters = systemdSchema;
	readonly strict = true;

	readonly #runCommand: SystemdCommandRunner;
	readonly #hasCommand: (command: string) => boolean;
	readonly #platform: NodeJS.Platform;
	readonly #now: () => Date;
	readonly #randomSuffix: () => string;

	constructor(
		private readonly session: ToolSession,
		options: SystemdToolOptions = {},
	) {
		this.#runCommand = options.runCommand ?? defaultRunCommand;
		this.#hasCommand = options.hasCommand ?? (command => Boolean($which(command)));
		this.#platform = options.platform ?? process.platform;
		this.#now = options.now ?? (() => new Date());
		this.#randomSuffix = options.randomSuffix ?? (() => Math.random().toString(36).slice(2, 8));
	}

	async execute(
		_toolCallId: string,
		params: SystemdParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SystemdToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SystemdToolDetails>> {
		return untilAborted(signal, async () => {
			switch (params.op) {
				case "submit":
					assertAllowedFields(params, [
						"unit",
						"command",
						"cwd",
						"env",
						"memory",
						"cpuQuota",
						"gpu",
						"description",
						"remainAfterExit",
					]);
					await this.#ensureEnvironment(["systemctl", "systemd-run"], signal);
					return this.#submit(params, signal);
				case "status":
					assertAllowedFields(params, ["unit"]);
					await this.#ensureEnvironment(["systemctl"], signal);
					return this.#status(params, signal);
				case "logs":
					assertAllowedFields(params, ["unit", "lines"]);
					await this.#ensureEnvironment(["systemctl", "journalctl"], signal);
					return this.#logs(params, signal);
				case "stop":
					assertAllowedFields(params, ["unit"]);
					await this.#ensureEnvironment(["systemctl"], signal);
					return this.#stop(params, signal);
				case "list":
					assertAllowedFields(params, []);
					await this.#ensureEnvironment(["systemctl"], signal);
					return this.#list(signal);
			}
		});
	}

	async #ensureEnvironment(commands: readonly string[], signal: AbortSignal | undefined): Promise<void> {
		if (this.#platform !== "linux") {
			throw new ToolError("systemd tool is only supported on Linux user sessions.");
		}
		for (const command of commands) {
			if (!this.#hasCommand(command)) {
				throw new ToolError(`systemd tool requires ${command} in PATH.`);
			}
		}
		const probe = await this.#runCommand(["systemctl", "--user", "show", "--property=Version", "--value"], {
			cwd: this.session.cwd,
			signal,
		});
		if (probe.exitCode !== 0) {
			throw new ToolError(`systemd --user manager is unavailable: ${systemdFailureMessage(probe)}`);
		}
	}

	#runCheckedWithEnv(
		args: readonly string[],
		signal: AbortSignal | undefined,
		env?: Record<string, string>,
	): Promise<SystemdCommandResult> {
		return (async () => {
			const result = await this.#runCommand(args, { cwd: this.session.cwd, signal, env });
			if (result.exitCode !== 0) {
				throw new ToolError(systemdFailureMessage(result));
			}
			return result;
		})();
	}

	async #runChecked(args: readonly string[], signal: AbortSignal | undefined): Promise<SystemdCommandResult> {
		return this.#runCheckedWithEnv(args, signal);
	}

	async #readUnitStatus(unit: string, signal: AbortSignal | undefined): Promise<ParsedUnitStatus> {
		const result = await this.#runChecked(
			[
				"systemctl",
				"--user",
				"show",
				unit,
				`--property=${SYSTEMD_SHOW_PROPERTIES.join(",")}`,
			],
			signal,
		);
		const parsed = parseUnitStatus(result.stdout);
		if (!parsed.snapshot.unit) {
			throw new ToolError(`Unable to read status for ${unit}`);
		}
		return parsed;
	}

	async #readManagedUnitStatus(unit: string, signal: AbortSignal | undefined): Promise<SystemdUnitSnapshot> {
		const parsed = await this.#readUnitStatus(unit, signal);
		if (!hasManagedEnvironment(parsed.environment)) {
			throw new ToolError(`${unit} is not managed by the systemd tool.`);
		}
		return parsed.snapshot;
	}

	async #tryReadManagedUnitStatus(
		unit: string,
		action: "submit" | "stop",
		signal: AbortSignal | undefined,
	): Promise<{ snapshot?: SystemdUnitSnapshot; warning?: string }> {
		try {
			return { snapshot: await this.#readManagedUnitStatus(unit, signal) };
		} catch (error) {
			if (error instanceof ToolError && isMissingUnitMessage(error.message)) {
				return {
					warning: `Warning: ${action === "submit" ? "service was submitted" : "service was stopped"}, but status refresh failed: ${error.message}`,
				};
			}
			throw error;
		}
	}

	async #tryReadStoppedManagedUnitStatus(
		unit: string,
		signal: AbortSignal | undefined,
	): Promise<{ snapshot?: SystemdUnitSnapshot; warning?: string }> {
		let lastRefresh = await this.#tryReadStoppedUnitStatusOnce(unit, signal);
		for (let attempt = 1; attempt < STOP_REFRESH_ATTEMPTS; attempt += 1) {
			if (!lastRefresh.snapshot) return lastRefresh;
			if (isStoppedUnitSnapshot(lastRefresh.snapshot)) return lastRefresh;
			await untilAborted(signal, () => Bun.sleep(STOP_REFRESH_DELAY_MS));
			lastRefresh = await this.#tryReadStoppedUnitStatusOnce(unit, signal);
		}
		return lastRefresh;
	}

	async #tryReadStoppedUnitStatusOnce(
		unit: string,
		signal: AbortSignal | undefined,
	): Promise<{ snapshot?: SystemdUnitSnapshot; warning?: string }> {
		try {
			const parsed = await this.#readUnitStatus(unit, signal);
			if (hasManagedEnvironment(parsed.environment) || isStoppedUnitSnapshot(parsed.snapshot)) {
				return { snapshot: parsed.snapshot };
			}
			throw new ToolError(`${unit} is not managed by the systemd tool.`);
		} catch (error) {
			if (error instanceof ToolError && isMissingUnitMessage(error.message)) {
				return {
					warning: `Warning: service was stopped, but status refresh failed: ${error.message}`,
				};
			}
			throw error;
		}
	}

	async #submit(params: SystemdParams, signal: AbortSignal | undefined): Promise<AgentToolResult<SystemdToolDetails>> {
		const command = normalizeNonEmpty(params.command, "command");
		const unit = params.unit
			? normalizeManagedUnitName(params.unit)
			: generateManagedUnitName(this.#now(), this.#randomSuffix());
		const cwd = params.cwd ? resolveToCwd(params.cwd, this.session.cwd) : this.session.cwd;
		const description = buildManagedDescription(command, normalizeOptionalValue(params.description, "description"));
		const env = normalizeEnv(params.env);
		const memory = normalizeOptionalValue(params.memory, "memory");
		const cpuQuota = normalizeOptionalValue(params.cpuQuota, "cpuQuota");
		const gpu = normalizeOptionalValue(params.gpu, "gpu");

		const submitArgs = [
			"systemd-run",
			"--user",
			"--quiet",
			`--unit=${unit}`,
			"--service-type=exec",
			`--working-directory=${cwd}`,
			`--description=${description}`,
		];
		if (params.remainAfterExit) submitArgs.push("--remain-after-exit");
		if (memory) submitArgs.push(`--property=MemoryMax=${memory}`);
		if (cpuQuota) submitArgs.push(`--property=CPUQuota=${cpuQuota}`);
		submitArgs.push(`--setenv=${SYSTEMD_TOOL_MANAGED_ENV}`);
		if (gpu) {
			submitArgs.push(`--setenv=CUDA_VISIBLE_DEVICES=${gpu}`);
			submitArgs.push(`--setenv=NVIDIA_VISIBLE_DEVICES=${gpu}`);
		}
		for (const [key, value] of Object.entries(env ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
			submitArgs.push(`--setenv=${key}=${value}`);
		}
		submitArgs.push("/bin/sh", "-lc", command);

		const commandEnv = env ? { ...env } : undefined;
		await this.#runCheckedWithEnv(submitArgs, signal, commandEnv);
		const refresh = await this.#tryReadManagedUnitStatus(unit, "submit", signal);
		const lines = [
			"Submitted managed user service.",
			`Unit: ${unit}`,
			`Command: ${previewCommand(command)}`,
			`Cwd: ${formatPathRelativeToCwd(cwd, this.session.cwd)}`,
		];
		if (refresh.snapshot) {
			lines.push(...formatUnitSnapshot(refresh.snapshot, this.session));
		}
		if (refresh.warning) {
			lines.push(refresh.warning);
		}
		return toolResult<SystemdToolDetails>({
			op: "submit",
			unit,
			units: refresh.snapshot ? [refresh.snapshot] : undefined,
			command,
			cwd,
		})
			.text(lines.join("\n"))
			.done();
	}

	async #status(params: SystemdParams, signal: AbortSignal | undefined): Promise<AgentToolResult<SystemdToolDetails>> {
		const unit = normalizeManagedUnitName(params.unit ?? "");
		const snapshot = await this.#readManagedUnitStatus(unit, signal);
		return toolResult<SystemdToolDetails>({ op: "status", unit, units: [snapshot] })
			.text(formatUnitSnapshot(snapshot, this.session).join("\n"))
			.done();
	}

	async #logs(params: SystemdParams, signal: AbortSignal | undefined): Promise<AgentToolResult<SystemdToolDetails>> {
		const unit = normalizeManagedUnitName(params.unit ?? "");
		await this.#readManagedUnitStatus(unit, signal);
		const lines = normalizeLogLines(params.lines);
		const result = await this.#runChecked(
			[
				"journalctl",
				"--user",
				"--unit",
				unit,
				"--no-pager",
				"--output=short-iso",
				"--lines",
				String(lines),
			],
			signal,
		);
		const text = result.stdout.trim();
		if (!text) {
			return toolResult<SystemdToolDetails>({ op: "logs", unit, lines })
				.text(`No journal output for ${unit}.`)
				.useless()
				.done();
		}
		return toolResult<SystemdToolDetails>({ op: "logs", unit, lines })
			.text(`Logs for ${unit}:\n\n${text}`)
			.done();
	}

	async #stop(params: SystemdParams, signal: AbortSignal | undefined): Promise<AgentToolResult<SystemdToolDetails>> {
		const unit = normalizeManagedUnitName(params.unit ?? "");
		await this.#readManagedUnitStatus(unit, signal);
		await this.#runChecked(["systemctl", "--user", "stop", unit], signal);
		const refresh = await this.#tryReadStoppedManagedUnitStatus(unit, signal);
		const lines = [`Stopped ${unit}.`];
		if (refresh.snapshot) {
			lines.push(...formatUnitSnapshot(refresh.snapshot, this.session));
		}
		if (refresh.warning) {
			lines.push(refresh.warning);
		}
		return toolResult<SystemdToolDetails>({ op: "stop", unit, units: refresh.snapshot ? [refresh.snapshot] : undefined })
			.text(lines.join("\n"))
			.done();
	}

	async #list(signal: AbortSignal | undefined): Promise<AgentToolResult<SystemdToolDetails>> {
		const result = await this.#runChecked(
			[
				"systemctl",
				"--user",
				"list-units",
				"--type=service",
				"--all",
				"--no-pager",
				"--plain",
				"--no-legend",
				`${SYSTEMD_TOOL_UNIT_PREFIX}*.service`,
			],
			signal,
		);
		const candidates = parseListUnits(result.stdout);
		const units: SystemdUnitSnapshot[] = [];
		for (const candidate of candidates) {
			try {
				units.push(await this.#readManagedUnitStatus(candidate.unit, signal));
			} catch (error) {
				if (
					error instanceof ToolError &&
					(/not managed by the systemd tool/u.test(error.message) || isMissingUnitMessage(error.message))
				) {
					continue;
				}
				throw error;
			}
		}
		if (units.length === 0) {
			return toolResult<SystemdToolDetails>({ op: "list", units: [] })
				.text("No managed systemd --user units found.")
				.useless()
				.done();
		}
		const lines = [`Managed systemd --user units (${units.length}):`];
		for (const unit of units) {
			lines.push(
				`- ${unit.unit} | ${unit.activeState ?? "unknown"}${unit.subState ? ` (${unit.subState})` : ""}${unit.description ? ` | ${unit.description}` : ""}`,
			);
		}
		return toolResult<SystemdToolDetails>({ op: "list", units }).text(lines.join("\n")).done();
	}
}
