import { describe, expect, it } from "vite-plus/test";
import {
  isExplicitRelativePath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
} from "./path.ts";

describe("path helpers", () => {
  it("detects windows drive paths", () => {
    expect(isWindowsDrivePath("C:\\repo")).toBe(true);
    expect(isWindowsDrivePath("D:/repo")).toBe(true);
    expect(isWindowsDrivePath("/repo")).toBe(false);
  });

  it("detects UNC paths", () => {
    expect(isUncPath("\\\\server\\share\\repo")).toBe(true);
    expect(isUncPath("C:\\repo")).toBe(false);
  });

  it("detects windows absolute paths", () => {
    expect(isWindowsAbsolutePath("C:\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("./repo")).toBe(false);
  });

  it("detects explicit relative paths", () => {
    expect(isExplicitRelativePath(".")).toBe(true);
    expect(isExplicitRelativePath("..")).toBe(true);
    expect(isExplicitRelativePath("./repo")).toBe(true);
    expect(isExplicitRelativePath("..\\repo")).toBe(true);
    expect(isExplicitRelativePath("~/repo")).toBe(false);
  });

  it("normalizes project paths for dispatch", () => {
    expect(normalizeProjectPathForDispatch(" /work/repo// ")).toBe("/work/repo");
    expect(normalizeProjectPathForDispatch("C:\\")).toBe("C:\\");
    expect(normalizeProjectPathForDispatch("C:\\repo\\\\")).toBe("C:\\repo");
  });

  it("normalizes project paths for cross-layer comparison", () => {
    expect(normalizeProjectPathForComparison("/work/repo/")).toBe("/work/repo");
    expect(normalizeProjectPathForComparison("C:/Work/Repo/")).toBe("c:\\work\\repo");
    expect(normalizeProjectPathForComparison("\\\\Server\\Share\\Repo\\")).toBe(
      "\\\\server\\share\\repo",
    );
  });
});
