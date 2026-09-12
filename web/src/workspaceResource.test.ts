import { defaultShortcutBindings } from "./shortcutBindings";
import { annotationDraftStorageKey } from "./annotations";
import { describe, expect, test } from "bun:test";
import type { Workspace } from "./types";
import {
  checkoutKeyForWorkspace,
  inspectorMaximumSize,
  inspectorNavigationRatioAtPosition,
  isWorkspaceInspectorShortcut as resolveShortcut,
  INSPECTOR_SEPARATOR_SIZE,
  readInspectorPreferences,
  readResourceFileSelection,
  relativePathWithinCheckout,
  resourceOwnerKey,
  resourceScopeForWorkspace,
  resourceStateKey,
  resolveWorkspaceForScope,
  sameResourceOwner,
  writeInspectorNavigationRatio,
  writeInspectorPreferences,
  writeResourceFileSelection,
  type WorkspaceInspectorState,
} from "./workspaceResource";

const isWorkspaceInspectorShortcut = (
  event: Parameters<typeof resolveShortcut>[0],
) => resolveShortcut(event, defaultShortcutBindings("mac"));

function workspace(
  workspaceId: string,
  checkoutPath?: string,
  settingsKey?: string,
): Workspace {
  return {
    workspace_id: workspaceId,
    number: 1,
    label: workspaceId,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    agent_status: "unknown",
    ...(checkoutPath
      ? {
          worktree: {
            repo_key: "repo-key",
            repo_name: "repo",
            repo_root: "/repo",
            checkout_path: checkoutPath,
            is_linked_worktree: checkoutPath !== "/repo",
            gui_settings_key: settingsKey ?? "local:repo-key",
          },
        }
      : {}),
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

describe("workspace inspector shortcuts", () => {
  const event = (overrides: Partial<KeyboardEvent> = {}) => ({
    key: "B",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
    repeat: false,
    ...overrides,
  });

  test("recognizes Cmd+Shift+B without colliding with sidebar or Ctrl shortcuts", () => {
    expect(isWorkspaceInspectorShortcut(event())).toBe(true);
    expect(isWorkspaceInspectorShortcut(event({ shiftKey: false }))).toBe(
      false,
    );
    expect(
      isWorkspaceInspectorShortcut(
        event({ metaKey: false, ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);
    expect(isWorkspaceInspectorShortcut(event({ repeat: true }))).toBe(false);
  });
});

describe("workspace inspector geometry", () => {
  test("preserves terminal minimums at the dock boundary", () => {
    const inspector = inspectorMaximumSize("right", 1000, 800);
    expect(inspector).toBe(513);
    expect(1000 - inspector - INSPECTOR_SEPARATOR_SIZE).toBe(480);
    expect(inspectorMaximumSize("bottom", 1000, 600)).toBe(353);
  });

  test("clamps the expanded navigation splitter around both pane minimums", () => {
    expect(inspectorNavigationRatioAtPosition(100, 1000)).toBe(0.24);
    expect(inspectorNavigationRatioAtPosition(400, 1000)).toBe(0.4);
    expect(inspectorNavigationRatioAtPosition(900, 1000)).toBe(0.692);
  });
});

describe("workspace resource scope", () => {
  test("isolates main and sibling worktrees even with the same repository settings key", () => {
    const storage = memoryStorage();
    const main = resourceScopeForWorkspace("local", workspace("main", "/repo"));
    const auth = resourceScopeForWorkspace(
      "local",
      workspace("auth", "/repo/.worktrees/auth"),
    );
    const docs = resourceScopeForWorkspace(
      "local",
      workspace("docs", "/repo/.worktrees/docs"),
    );
    expect(new Set([main, auth, docs].map(resourceStateKey)).size).toBe(3);
    expect(
      new Set([main, auth, docs].map(annotationDraftStorageKey)).size,
    ).toBe(3);
    writeResourceFileSelection(storage, auth, "auth-only.md");
    expect(readResourceFileSelection(storage, main)).toBeUndefined();
    expect(readResourceFileSelection(storage, docs)).toBeUndefined();
    writeResourceFileSelection(storage, main, "README.md");
    writeResourceFileSelection(storage, docs, "docs-only.md");
    expect(readResourceFileSelection(storage, auth)).toBe("auth-only.md");
    expect(readResourceFileSelection(storage, main)).toBe("README.md");
    expect(readResourceFileSelection(storage, docs)).toBe("docs-only.md");
    writeResourceFileSelection(storage, auth, null);
    expect(readResourceFileSelection(storage, main)).toBe("README.md");
    expect(readResourceFileSelection(storage, docs)).toBe("docs-only.md");
    writeInspectorPreferences(storage, {
      scope: auth,
      open: true,
      view: "changes",
      dock: "bottom",
      size: 410,
      expanded: false,
    });
    expect(readInspectorPreferences(storage, main)).toMatchObject({
      view: "files",
      dock: "right",
    });
    expect(readInspectorPreferences(storage, docs)).toMatchObject({
      view: "files",
      dock: "right",
    });
  });

  test("does not rebind a closed worktree to a sibling or a reused workspace id", () => {
    const original = workspace("auth", "/repo/.worktrees/auth");
    const scope = resourceScopeForWorkspace("local", original);
    const main = workspace("main", "/repo");
    const reused = workspace("auth", "/repo/.worktrees/docs");
    expect(resolveWorkspaceForScope(scope, [main, reused])).toBeUndefined();
    const reopened = workspace("reopened", "/repo/.worktrees/auth/");
    expect(resolveWorkspaceForScope(scope, [main, reused, reopened])).toBe(
      reopened,
    );
  });

  test("ignores repository settings enrichment and normalizes checkout separators", () => {
    const first = workspace("first", "C:\\repo\\wt\\", "settings-before");
    const second = workspace("second", "C:/repo/wt/", "settings-after");
    expect(
      sameResourceOwner(
        resourceScopeForWorkspace("local", first),
        resourceScopeForWorkspace("local", second),
      ),
    ).toBe(true);
    second.worktree!.gui_settings_key = undefined;
    expect(checkoutKeyForWorkspace(first)).toBe(
      checkoutKeyForWorkspace(second),
    );
  });

  test("encodes repository and checkout paths without delimiter collisions", () => {
    const first = workspace("first", "/wt");
    first.worktree!.repo_key = "repo:x";
    const second = workspace("second", "x:/wt");
    second.worktree!.repo_key = "repo";
    expect(checkoutKeyForWorkspace(first)).not.toBe(
      checkoutKeyForWorkspace(second),
    );
  });

  test("does not restore ambiguous legacy repository-wide state", () => {
    const storage = memoryStorage();
    const scope = resourceScopeForWorkspace(
      "legacy-default",
      workspace("auth", "/repo/.worktrees/auth"),
    );
    storage.setItem(
      "workspaceInspectorFile:checkout:local:repo-key",
      "sibling-only.md",
    );
    storage.setItem(
      "workspaceInspector:checkout:local:repo-key",
      JSON.stringify({ dock: "bottom", view: "changes" }),
    );
    expect(readResourceFileSelection(storage, scope)).toBeUndefined();
    expect(readInspectorPreferences(storage, scope)).toMatchObject({
      dock: "right",
      view: "files",
    });
    expect(
      storage.getItem("workspaceInspectorFile:checkout:local:repo-key"),
    ).toBe("sibling-only.md");
  });

  test("uses stable checkout identity instead of a runtime workspace id", () => {
    const first = workspace("w1", "/repo/.worktrees/auth/", "auth-settings");
    const reopened = workspace("w2", "/repo/.worktrees/auth", "auth-settings");
    const main = workspace("main", "/repo");

    expect(checkoutKeyForWorkspace(first)).toBe(
      JSON.stringify(["repo-key", "/repo/.worktrees/auth"]),
    );
    expect(checkoutKeyForWorkspace(main)).toBe(
      JSON.stringify(["repo-key", "/repo"]),
    );

    const firstScope = resourceScopeForWorkspace("local", first);
    const reopenedScope = resourceScopeForWorkspace("local", reopened);
    expect(resourceOwnerKey(firstScope)).toBe(
      `checkout:${JSON.stringify(["repo-key", "/repo/.worktrees/auth"])}`,
    );
    expect(sameResourceOwner(firstScope, reopenedScope)).toBe(true);
    expect(resolveWorkspaceForScope(firstScope, [reopened])).toBe(reopened);
  });

  test("keeps identical checkout paths isolated by repository and connection", () => {
    const left = resourceScopeForWorkspace(
      "left",
      workspace("w1", "/worktree"),
    );
    const rightConnection = resourceScopeForWorkspace(
      "right",
      workspace("w2", "/worktree"),
    );
    const rightRepoWorkspace = workspace("w3", "/worktree");
    if (rightRepoWorkspace.worktree)
      rightRepoWorkspace.worktree.repo_key = "other";
    const rightRepo = resourceScopeForWorkspace("left", rightRepoWorkspace);

    expect(sameResourceOwner(left, rightConnection)).toBe(false);
    expect(sameResourceOwner(left, rightRepo)).toBe(false);
    expect(resourceStateKey(left)).not.toBe(resourceStateKey(rightConnection));
    expect(resourceStateKey(left)).not.toBe(resourceStateKey(rightRepo));
  });

  test("accepts an agent cwd only when it is inside the checkout", () => {
    expect(relativePathWithinCheckout("/repo/wt", "/repo/wt/src/auth")).toBe(
      "src/auth",
    );
    expect(relativePathWithinCheckout("/repo/wt/", "/repo/wt")).toBe("");
    expect(relativePathWithinCheckout("/repo/wt", "/repo/wt-other/src")).toBe(
      undefined,
    );
    expect(relativePathWithinCheckout("/repo/wt", "/tmp/outside")).toBe(
      undefined,
    );
  });

  test("persists dock and size independently for each checkout", () => {
    const storage = memoryStorage();
    const scope = resourceScopeForWorkspace(
      "local",
      workspace("w1", "/repo/.worktrees/auth", "auth"),
    );
    const state: WorkspaceInspectorState = {
      scope,
      open: true,
      view: "changes",
      dock: "bottom",
      size: 410,
      expanded: false,
    };

    writeInspectorPreferences(storage, state);
    expect(readInspectorPreferences(storage, scope)).toEqual({
      view: "changes",
      dock: "bottom",
      rightSize: 520,
      bottomSize: 410,
      filesNavigationRatio: 0.4,
      changesNavigationRatio: 0.4,
    });

    writeInspectorNavigationRatio(storage, scope, "files", 0.56);
    expect(readInspectorPreferences(storage, scope).filesNavigationRatio).toBe(
      0.56,
    );

    writeInspectorPreferences(storage, { ...state, view: "history" });
    expect(readInspectorPreferences(storage, scope)).toMatchObject({
      view: "history",
      filesNavigationRatio: 0.56,
      changesNavigationRatio: 0.4,
    });
  });
});
