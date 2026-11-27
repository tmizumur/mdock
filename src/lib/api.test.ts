import { describe, expect, it } from "vitest";
import { parseFileError } from "./api";

describe("ファイル操作のエラー", () => {
  it.each([
    ["not_found", "ファイルが見つかりません。"],
    ["permission_denied", "ファイルへのアクセス権限がありません。"],
    ["is_directory", "フォルダです。"],
    ["invalid_encoding", "文字コードを判定できません。"],
    ["unrepresentable", "指定した文字コードで保存できない文字があります。"],
  ])("%s の理由を判別する", (code, message) => {
    expect(parseFileError({ code })).toEqual({ code, message });
  });

  it("特殊ファイルの種類が分かる理由を保持する", () => {
    const error = { code: "not_regular_file", message: "名前付きパイプのため開けません。" };
    expect(parseFileError(error)).toEqual(error);
  });

  it.each(["large_file", "too_large"])("%s のバイト数を保持する", (code) => {
    const size = 6 * 1024 * 1024;
    expect(parseFileError({ code, size })).toMatchObject({ code, size });
    expect(parseFileError({ code, size: "6 MB" }).size).toBeUndefined();
  });

  it.each(["IPC error", null, { code: "toString" }])("未知の形式では共通の理由を返す", (error) => {
    expect(parseFileError(error)).toEqual({ code: "other", message: "ファイルの操作中にエラーが発生しました。" });
  });
});
