import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createTools,
	SystemdTool,
	type SystemdCommandResult,
	type SystemdCommandRunner,
	type ToolSession,
} from "@oh-my-pi/pi-coding-agent/tools";

const MANAGED_ENV = "OMP_MANAGED_BY=oh-my-pi-systemd";

function makeSession(settingsOverrides: Record<string, unknown> = {}, cwd = "/tmp/project"): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(settingsOverrides),
		isToolDiscoveryEnabled: () => true,
		getSelectedDiscoveredToolNames: () => [],
		activateDiscoveredTools: async names => names,
	} as ToolSession;
}

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.find(item => item.type === "text")?.text ?? "";
}

function showOutput(lines: Record<string, string | number | undefined>): string {
	return Object.entries(lines)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}

function managedShowOutput(lines: Record<string, string | number | undefined>): string {
	return showOutput({ Environment: MANAGED_ENV, ...lines });
}

type MockResponse = {
	content?: Array<{ type: string; id?: string; name?: string; text?: string; arguments?: Record<string, unknown> }>;
	stopReason?: "toolUse" | "stop";
};

function toolCallResponse(name: string, args: Record<string, unknown>, callId: string): MockResponse {
	return {
		content: [{ type: "toolCall", id: callId, name, arguments: args }],
		stopReason: "toolUse",
	};
}

function stopReply(text: string): MockResponse {
	return {
		content: [{ type: "text", text }],
		stopReason: "stop",
	};
}

function createMockModel(options: { handler: () => MockResponse }) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");
	return {
		stream: async function* () {
			const response = options.handler();
			yield {
				type: "messageStart",
				message: { role: "assistant", content: response.content ?? [] },
			};
			yield {
				type: "messageStop",
				message: { role: "assistant", content: response.content ?? [] },
				stopReason: response.stopReason ?? "stop",
			};
		},
		model,
	};
}

describe("SystemdTool gating", () => {
	it("respects systemd.enabled in createTools", async () => {
		const disabled = await createTools(makeSession({ "systemd.enabled": false }), ["systemd"]);
		expect(disabled.some(tool => tool.name === "systemd")).toBe(false);

		const enabled = await createTools(makeSession({ "systemd.enabled": true }), ["systemd"]);
		expect(enabled.some(tool => tool.name === "systemd")).toBe(true);
	});
});

describe("SystemdTool approvals", () => {
	it("uses read approval for inspection ops and exec for mutating ops", () => {
		const tool = new SystemdTool(makeSession({ "systemd.enabled": true }));
		expect(tool.approval({ op: "list" })).toBe("read");
		expect(tool.approval({ op: "status" })).toBe("read");
		expect(tool.approval({ op: "logs" })).toBe("read");
		expect(tool.approval({ op: "submit" })).toBe("exec");
		expect(tool.approval({ op: "stop" })).toBe("exec");
	});
});

describe("SystemdTool execution", () => {
	it("submits a managed user service and maps submit fields to systemd-run flags", async () => {
		const calls: Array<{ args: string[]; cwd: string }> = [];
		const runner: SystemdCommandRunner = async (args, options) => {
			calls.push({ args: [...args], cwd: options.cwd });
			if (args[0] === "systemctl" && args.includes("--property=Version") && args.includes("--value")) {
				return { exitCode: 0, stdout: "255\n", stderr: "" };
			}
			if (args[0] === "systemd-run") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "systemctl" && args[2] === "show") {
				return {
					exitCode: 0,
					stdout: managedShowOutput({
						Id: "omp-20260627-123456-abcdef.service",
						Description: "oh-my-pi: python train.py --epochs 3",
						LoadState: "loaded",
						ActiveState: "active",
						SubState: "running",
						Result: "success",
						ExecMainPID: 4321,
					}),
					stderr: "",
				};
			}
			throw new Error(`Unexpected command: ${args.join(" ")}`);
		};

		const tool = new SystemdTool(makeSession({ "systemd.enabled": true }), {
			runCommand: runner,
			hasCommand: () => true,
			platform: "linux",
			now: () => new Date(2026, 5, 27, 12, 34, 56),
			randomSuffix: () => "abcdef",
		});

		const result = await tool.execute("submit-call", {
			op: "submit",
			command: "python train.py --epochs 3",
			cwd: "runs",
			env: { WANDB_MODE: "offline" },
			memory: "16G",
			cpuQuota: "200%",
			gpu: "0,1",
			remainAfterExit: true,
		});

		const submitCall = calls.find(call => call.args[0] === "systemd-run");
		expect(submitCall).toBeDefined();
		expect(submitCall?.args).toContain("--user");
		expect(submitCall?.args).toContain("--quiet");
		expect(submitCall?.args).toContain("--remain-after-exit");
		expect(submitCall?.args).toContain("--unit=omp-20260627-123456-abcdef.service");
		expect(submitCall?.args).toContain("--working-directory=/tmp/project/runs");
		expect(submitCall?.args).toContain("--property=MemoryMax=16G");
		expect(submitCall?.args).toContain("--property=CPUQuota=200%");
		expect(submitCall?.args).toContain("--setenv=OMP_MANAGED_BY=oh-my-pi-systemd");
		expect(submitCall?.args).toContain("--setenv=WANDB_MODE=offline");
		expect(submitCall?.args).toContain("--setenv=CUDA_VISIBLE_DEVICES=0,1");
		expect(submitCall?.args).toContain("--setenv=NVIDIA_VISIBLE_DEVICES=0,1");
		expect(submitCall?.args.slice(-3)).toEqual(["/bin/sh", "-lc", "python train.py --epochs 3"]);
		expect(getTextOutput(result)).toContain("Submitted managed user service.");
		expect(getTextOutput(result)).toContain("omp-20260627-123456-abcdef.service");
		expect(result.details?.units?.[0]?.activeState).toBe("active");
	});

	it("passes normalized submit env as child-process env overrides", async () => {
		const captured: Array<{ args: string[]; env?: Record<string, string> }> = [];
		const runner: SystemdCommandRunner = async (args, options) => {
			captured.push({ args: [...args], env: options.env });
			if (args[0] === "systemctl" && args.includes("--property=Version") && args.includes("--value")) {
				return { exitCode: 0, stdout: "255\n", stderr: "" };
			}
			if (args[0] === "systemd-run") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "systemctl" && args[2] === "show") {
				return {
					exitCode: 0,
					stdout: managedShowOutput({
						Id: "omp-20260627-123456-abcdef.service",
						LoadState: "loaded",
						ActiveState: "active",
						SubState: "running",
					}),
					stderr: "",
				};
			}
			throw new Error(`Unexpected command: ${args.join(" ")}`);
		};

		const tool = new SystemdTool(makeSession({ "systemd.enabled": true }), {
			runCommand: runner,
			hasCommand: () => true,
			platform: "linux",
			now: () => new Date(2026, 5, 27, 12, 34, 56),
			randomSuffix: () => "abcdef",
		});

		await tool.execute("submit-env-call", {
			op: "submit",
			command: "env | grep HELLO",
			env: { HELLO: "world" },
		});

		const submitCall = captured.find(call => call.args[0] === "systemd-run");
		expect(submitCall?.env).toEqual({ HELLO: "world" });
	});

	it("returns status and normalizes short aliases for managed units", async () => {
		const commands: string[][] = [];
		const runner: SystemdCommandRunner = async args => {
			commands.push([...args]);
			if (args[0] === "systemctl" && args.includes("--property=Version") && args.includes("--value")) {
				return { exitCode: 0, stdout: "255\n", stderr: "" };
			}
			if (args[0] === "journalctl") {
				return { exitCode: 0, stdout: "2026-06-27 12:00:00 loss=0.42\n", stderr: "" };
			}
			if (args[0] === "systemctl" && args[2] === "stop") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "systemctl" && args[2] === "show") {
				return {
					exitCode: 0,
					stdout: managedShowOutput({
						Id: "omp-trainer.service",
						LoadState: "loaded",
						ActiveState: "inactive",
						SubState: "dead",
						Result: "success",
					}),
					stderr: "",
				};
			}
			throw new Error(`Unexpected command: ${args.join(" ")}`);
		};

		const tool = new SystemdTool(makeSession({ "systemd.enabled": true }), {
			runCommand: runner,
			hasCommand: () => true,
			platform: "linux",
		});

		const status = await tool.execute("status-call", { op: "status", unit: "trainer" });
		expect(getTextOutput(status)).toContain("Unit: omp-trainer.service");

		const logs = await tool.execute("logs-call", { op: "logs", unit: "trainer", lines: 20 });
		expect(getTextOutput(logs)).toContain("Logs for omp-trainer.service");

		const stopped = await tool.execute("stop-call", { op: "stop", unit: "trainer" });
		expect(getTextOutput(stopped)).toContain("Stopped omp-trainer.service.");
		expect(commands.some(args => args[0] === "journalctl" && args.includes("omp-trainer.service"))).toBe(true);
		expect(commands.some(args => args[0] === "systemctl" && args[2] === "stop" && args[3] === "omp-trainer.service")).toBe(true);
	});

	it("rejects prefixed units that are not marked as tool-managed", async () => {
		const runner: SystemdCommandRunner = async args => {
			if (args[0] === "systemctl" && args.includes("--property=Version") && args.includes("--value")) {
				return { exitCode: 0, stdout: "255\n", stderr: "" };
			}
			if (args[0] === "systemctl" && args[2] === "show") {
				return {
					exitCode: 0,
					stdout: showOutput({
						Id: "omp-foreign.service",
						LoadState: "loaded",
						ActiveState: "active",
						SubState: "running",
					}),
					stderr: "",
				};
			}
			throw new Error(`Unexpected command: ${args.join(" ")}`);
		};
		const tool = new SystemdTool(makeSession({ "systemd.enabled": true }), {
			runCommand: runner,
			hasCommand: () => true,
			platform: "linux",
		});

		await expect(tool.execute("status-call", { op: "status", unit: "foreign" })).rejects.toThrow(
			/not managed by the systemd tool/,
		);
		await expect(tool.execute("logs-call", { op: "logs", unit: "foreign" })).rejects.toThrow(
			/not managed by the systemd tool/,
		);
		await expect(tool.execute("stop-call", { op: "stop", unit: "foreign" })).rejects.toThrow(
			/not managed by the systemd tool/,
		);
	});

	it("filters unmanaged prefixed units from list output", async () => {
		const runner: SystemdCommandRunner = async args => {
			if (args[0] === "systemctl" && args.includes("--property=Version") && args.includes("--value")) {
				return { exitCode: 0, stdout: "255\n", stderr: "" };
			}
			if (args[0] === "systemctl" && args[2] === "list-units") {
				return {
					exitCode: 0,
					stdout: [
						"omp-trainer.service loaded active running managed trainer",
						"omp-foreign.service loaded active running foreign service",
					].join("\n"),
					stderr: "",
				};
			}
			if (args[0] === "systemctl" && args[2] === "show" && args[3] === "omp-trainer.service") {
				return {
					exitCode: 0,
					stdout: managedShowOutput({
						Id: "omp-trainer.service",
						LoadState: "loaded",
						ActiveState: "active",
						SubState: "running",
						Description: "managed trainer",
					}),
					stderr: "",
				};
			}
			if (args[0] === "systemctl" && args[2] === "show" && args[3] === "omp-foreign.service") {
				return {
					exitCode: 0,
					stdout: showOutput({
						Id: "omp-foreign.service",
						LoadState: "loaded",
						ActiveState: "active",
						SubState: "running",
						Description: "foreign service",
					}),
					stderr: "",
				};
			}
			throw new Error(`Unexpected command: ${args.join(" ")}`);
		};
		const tool = new SystemdTool(makeSession({ "systemd.enabled": true }), {
			runCommand: runner,
			hasCommand: () => true,
			platform: "linux",
		});

		const listed = await tool.execute("list-call", { op: "list" });
		expect(getTextOutput(listed)).toContain("omp-trainer.service");
		expect(getTextOutput(listed)).not.toContain("omp-foreign.service");
		expect(listed.details?.units?.map(unit => unit.unit)).toEqual(["omp-trainer.service"]);
	});

	it("marks empty list and empty logs as useless", async () => {
		const runner: SystemdCommandRunner = async args => {
			if (args[0] === "systemctl" && args.includes("--property=Version") && args.includes("--value")) {
				return { exitCode: 0, stdout: "255\n", stderr: "" };
			}
			if (args[0] === "systemctl" && args[2] === "list-units") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "systemctl" && args[2] === "show") {
				return {
					exitCode: 0,
					stdout: managedShowOutput({
						Id: "omp-trainer.service",
						LoadState: "loaded",
						ActiveState: "active",
						SubState: "running",
					}),
					stderr: "",
				};
			}
			if (args[0] === "journalctl") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			throw new Error(`Unexpected command: ${args.join(" ")}`);
		};
		const tool = new SystemdTool(makeSession({ "systemd.enabled": true }), {
			runCommand: runner,
			hasCommand: () => true,
			platform: "linux",
		});

		const listed = await tool.execute("list-call", { op: "list" });
		expect(listed.useless).toBe(true);
		expect(getTextOutput(listed)).toContain("No managed systemd --user units found.");

		const logs = await tool.execute("logs-call", { op: "logs", unit: "trainer" });
		expect(logs.useless).toBe(true);
		expect(getTextOutput(logs)).toContain("No journal output for omp-trainer.service.");
	});

	it("keeps submit successful when status refresh loses the unit", async () => {
		const tool = new SystemdTool(makeSession({ "systemd.enabled": true }), {
			runCommand: async args => {
				if (args[0] === "systemctl" && args.includes("--property=Version") && args.includes("--value")) {
					return { exitCode: 0, stdout: "255\n", stderr: "" };
				}
				if (args[0] === "systemd-run") {
					return { exitCode: 0, stdout: "", stderr: "" };
				}
				if (args[0] === "systemctl" && args[2] === "show") {
					return {
						exitCode: 1,
						stdout: "",
						stderr: "Unit omp-20260627-123456-abcdef.service could not be found.",
					};
				}
				throw new Error(`Unexpected command: ${args.join(" ")}`);
			},
			hasCommand: () => true,
			platform: "linux",
			now: () => new Date(2026, 5, 27, 12, 34, 56),
			randomSuffix: () => "abcdef",
		});

		const result = await tool.execute("submit-call", {
			op: "submit",
			command: "python train.py --epochs 3",
		});

		expect(getTextOutput(result)).toContain("Submitted managed user service.");
		expect(getTextOutput(result)).toContain("Warning: service was submitted, but status refresh failed");
		expect(result.details?.units).toBeUndefined();
	});

	it("keeps stop successful when post-stop status refresh loses the unit", async () => {
		let showCount = 0;
		const tool = new SystemdTool(makeSession({ "systemd.enabled": true }), {
			runCommand: async args => {
				if (args[0] === "systemctl" && args.includes("--property=Version") && args.includes("--value")) {
					return { exitCode: 0, stdout: "255\n", stderr: "" };
				}
				if (args[0] === "systemctl" && args[2] === "show") {
					showCount += 1;
					if (showCount === 1) {
						return {
							exitCode: 0,
							stdout: managedShowOutput({
								Id: "omp-trainer.service",
								LoadState: "loaded",
								ActiveState: "active",
								SubState: "running",
							}),
							stderr: "",
						};
					}
					return {
						exitCode: 1,
						stdout: "",
						stderr: "Unit omp-trainer.service could not be found.",
					};
				}
				if (args[0] === "systemctl" && args[2] === "stop") {
					return { exitCode: 0, stdout: "", stderr: "" };
				}
				throw new Error(`Unexpected command: ${args.join(" ")}`);
			},
			hasCommand: () => true,
			platform: "linux",
		});

		const result = await tool.execute("stop-call", { op: "stop", unit: "trainer" });

		expect(getTextOutput(result)).toContain("Stopped omp-trainer.service.");
		expect(getTextOutput(result)).toContain("Warning: service was stopped, but status refresh failed");
		expect(result.details?.units).toBeUndefined();
	});

	it("waits for stop refresh to settle before returning a final snapshot", async () => {
		let showCount = 0;
		const tool = new SystemdTool(makeSession({ "systemd.enabled": true }), {
			runCommand: async args => {
				if (args[0] === "systemctl" && args.includes("--property=Version") && args.includes("--value")) {
					return { exitCode: 0, stdout: "255\n", stderr: "" };
				}
				if (args[0] === "systemctl" && args[2] === "show") {
					showCount += 1;
					if (showCount === 1) {
						return {
							exitCode: 0,
							stdout: managedShowOutput({
								Id: "omp-trainer.service",
								LoadState: "loaded",
								ActiveState: "active",
								SubState: "running",
							}),
							stderr: "",
						};
					}
					if (showCount === 2) {
						return {
							exitCode: 0,
							stdout: managedShowOutput({
								Id: "omp-trainer.service",
								LoadState: "loaded",
								ActiveState: "active",
								SubState: "running",
							}),
							stderr: "",
						};
					}
					return {
						exitCode: 0,
						stdout: managedShowOutput({
							Id: "omp-trainer.service",
							LoadState: "not-found",
							ActiveState: "inactive",
							SubState: "dead",
							Result: "success",
						}),
						stderr: "",
					};
				}
				if (args[0] === "systemctl" && args[2] === "stop") {
					return { exitCode: 0, stdout: "", stderr: "" };
				}
				throw new Error(`Unexpected command: ${args.join(" ")}`);
			},
			hasCommand: () => true,
			platform: "linux",
		});

		const result = await tool.execute("stop-call", { op: "stop", unit: "trainer" });

		expect(showCount).toBeGreaterThanOrEqual(3);
		expect(getTextOutput(result)).toContain("Stopped omp-trainer.service.");
		expect(getTextOutput(result)).toContain("State: inactive (dead)");
		expect(result.details?.units?.[0]?.activeState).toBe("inactive");
		expect(result.details?.units?.[0]?.subState).toBe("dead");
	});

	it("accepts an unloaded inactive/dead unit after stop even when the managed marker is gone", async () => {
		let showCount = 0;
		const tool = new SystemdTool(makeSession({ "systemd.enabled": true }), {
			runCommand: async args => {
				if (args[0] === "systemctl" && args.includes("--property=Version") && args.includes("--value")) {
					return { exitCode: 0, stdout: "255\n", stderr: "" };
				}
				if (args[0] === "systemctl" && args[2] === "show") {
					showCount += 1;
					if (showCount === 1) {
						return {
							exitCode: 0,
							stdout: managedShowOutput({
								Id: "omp-trainer.service",
								LoadState: "loaded",
								ActiveState: "active",
								SubState: "running",
							}),
							stderr: "",
						};
					}
					return {
						exitCode: 0,
						stdout: showOutput({
							Id: "omp-trainer.service",
							LoadState: "not-found",
							ActiveState: "inactive",
							SubState: "dead",
							Result: "success",
						}),
						stderr: "",
					};
				}
				if (args[0] === "systemctl" && args[2] === "stop") {
					return { exitCode: 0, stdout: "", stderr: "" };
				}
				throw new Error(`Unexpected command: ${args.join(" ")}`);
			},
			hasCommand: () => true,
			platform: "linux",
		});

		const result = await tool.execute("stop-call", { op: "stop", unit: "trainer" });

		expect(showCount).toBeGreaterThanOrEqual(2);
		expect(getTextOutput(result)).toContain("State: inactive (dead)");
		expect(getTextOutput(result)).not.toContain("status refresh failed");
		expect(result.details?.units?.[0]?.loadState).toBe("not-found");
		expect(result.details?.units?.[0]?.activeState).toBe("inactive");
		expect(result.details?.units?.[0]?.subState).toBe("dead");
	});

	it("rejects unrelated fields on list", async () => {
		const runner: SystemdCommandRunner = async (): Promise<SystemdCommandResult> => ({
			exitCode: 0,
			stdout: "255\n",
			stderr: "",
		});
		const tool = new SystemdTool(makeSession({ "systemd.enabled": true }), {
			runCommand: runner,
			hasCommand: () => true,
			platform: "linux",
		});

		await expect(tool.execute("list-invalid", { op: "list", unit: "trainer" })).rejects.toThrow(
			/`unit` is not valid for op list/,
		);
	});

	it("rejects submit with invalid env names before calling systemd", async () => {
		const calls: string[][] = [];
		const tool = new SystemdTool(makeSession({ "systemd.enabled": true }), {
			runCommand: async args => {
				calls.push([...args]);
				if (args[0] === "systemctl" && args.includes("--property=Version") && args.includes("--value")) {
					return { exitCode: 0, stdout: "255\n", stderr: "" };
				}
				throw new Error(`Unexpected command: ${args.join(" ")}`);
			},
			hasCommand: () => true,
			platform: "linux",
		});

		await expect(
			tool.execute("submit-invalid-env", {
				op: "submit",
				command: "python train.py",
				env: { "BAD-NAME": "1" },
			}),
		).rejects.toThrow(/Invalid systemd env name: BAD-NAME/);
		expect(calls.some(args => args[0] === "systemd-run")).toBe(false);
	});

	it("fails fast when the user systemd manager probe fails", async () => {
		const commands: string[][] = [];
		const tool = new SystemdTool(makeSession({ "systemd.enabled": true }), {
			runCommand: async args => {
				commands.push([...args]);
				return {
					exitCode: 1,
					stdout: "",
					stderr: "Failed to connect to bus: No medium found",
				};
			},
			hasCommand: () => true,
			platform: "linux",
		});

		await expect(tool.execute("list-no-manager", { op: "list" })).rejects.toThrow(
			/systemd --user manager is unavailable: Failed to connect to bus: No medium found/,
		);
		expect(commands).toEqual([["systemctl", "--user", "show", "--property=Version", "--value"]]);
	});

	it("fails fast when a required systemd binary is missing", async () => {
		const tool = new SystemdTool(makeSession({ "systemd.enabled": true }), {
			runCommand: async () => ({ exitCode: 0, stdout: "255\n", stderr: "" }),
			hasCommand: command => command !== "journalctl",
			platform: "linux",
		});

		await expect(tool.execute("logs-missing-binary", { op: "logs", unit: "trainer" })).rejects.toThrow(
			/systemd tool requires journalctl in PATH/,
		);
	});
	it("normalizes log line values and still rejects invalid unit names", async () => {
		const journalCalls: string[][] = [];
		const tool = new SystemdTool(makeSession({ "systemd.enabled": true }), {
			runCommand: async args => {
				if (args[0] === "systemctl" && args.includes("--property=Version") && args.includes("--value")) {
					return { exitCode: 0, stdout: "255\n", stderr: "" };
				}
				if (args[0] === "systemctl" && args[2] === "show") {
					return {
						exitCode: 0,
						stdout: managedShowOutput({
							Id: "omp-trainer.service",
							LoadState: "loaded",
							ActiveState: "active",
							SubState: "running",
						}),
						stderr: "",
					};
				}
				if (args[0] === "journalctl") {
					journalCalls.push([...args]);
					return { exitCode: 0, stdout: "2026-06-27 12:00:00 step\n", stderr: "" };
				}
				throw new Error(`Unexpected command: ${args.join(" ")}`);
			},
			hasCommand: () => true,
			platform: "linux",
		});

		await expect(tool.execute("logs-zero-lines", { op: "logs", unit: "trainer", lines: 0 })).rejects.toThrow(
			/lines must be a positive number/,
		);

		const logs = await tool.execute("logs-too-many-lines", { op: "logs", unit: "trainer", lines: 501 });
		expect(getTextOutput(logs)).toContain("Logs for omp-trainer.service");
		expect(journalCalls.at(-1)).toContain("500");

		await expect(tool.execute("status-bad-unit", { op: "status", unit: "bad/unit" })).rejects.toThrow(
			/systemd tool only manages omp-\*\.service units|Invalid unit name/,
		);
	});
});
