import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildSystemPrompt,
	type SystemPromptToolMetadata,
} from "@oh-my-pi/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

const TOOLS = new Map<string, SystemPromptToolMetadata>([
	[
		"read",
		{
			label: "Read",
			description: "Reads files from disk.",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	],
	[
		"search",
		{
			label: "Search",
			description: "Searches text.",
			parameters: { type: "object", properties: { pattern: { type: "string" } } },
		},
	],
	[
		"task",
		{
			label: "Task",
			description: "Runs a subagent task.",
			parameters: { type: "object", properties: { assignment: { type: "string" } } },
		},
	],
	[
		"lsp",
		{
			label: "LSP",
			description: "Language-server code intelligence.",
			parameters: { type: "object", properties: { symbol: { type: "string" } } },
		},
	],
]);

describe("system prompt research gate", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-research-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-research-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("makes code reading an explicit gate before edits and reframes research as forward progress", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read", "search", "task", "lsp"],
			tools: TOOLS,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});

		const text = systemPrompt.join("\n\n");

		expect(text).toContain("Before the first edit, write, or code-changing delegation, you MUST establish an evidence base");
		expect(text).toContain("At session start, orient first: review the workspace tree and context files already in your context");
		expect(text).toContain("You MUST NOT issue the first `edit`/`write`/`ast_edit` until you have read at least one project file");
		expect(text).toContain("Your first action in a new session MUST be orientation, not editing");
		expect(text).toContain("editing blind is PROHIBITED");
		expect(text).toContain("Read at least one constraining neighbor: a caller, a test, or a sibling implementation");
		expect(text).toContain("If you cannot yet name the exact file and symbol or section to change, you are still researching");
		expect(text).toContain("They NEVER replace reading the code you will change.");
		expect(text).toContain("Research, code reading, and validation count as progress");
		expect(text).toContain("investigate first instead of asking for confirmation or guessing");
	});
});
