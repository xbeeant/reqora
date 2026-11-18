import test from "node:test";
import assert from "node:assert/strict";
import {
  fileNameFromContentDisposition,
  suggestDownloadFileName,
} from "../src/lib/downloadName.ts";

const response = (overrides = {}) => ({ headers: [], url: "", ...overrides });

test("RFC 5987 filename* takes precedence and is percent-decoded", () => {
  const name = fileNameFromContentDisposition(
    "attachment; filename=\"fallback.txt\"; filename*=UTF-8''%E6%8A%A5%E8%A1%A8.pdf",
  );
  assert.equal(name, "报表.pdf");
  assert.equal(
    suggestDownloadFileName(
      response({
        headers: [
          { name: "Content-Disposition", value: "attachment; filename*=UTF-8''%E6%8A%A5%E8%A1%A8.pdf" },
        ],
      }),
      "下载接口",
    ),
    "报表.pdf",
  );
});

test("quoted filename is used and path components are stripped", () => {
  assert.equal(
    fileNameFromContentDisposition("attachment; filename=\"../../etc/passwd\""),
    "../../etc/passwd",
  );
  assert.equal(
    suggestDownloadFileName(
      response({
        headers: [{ name: "content-disposition", value: "attachment; filename=\"../../etc/report.csv\"" }],
      }),
      "接口",
    ),
    "report.csv",
  );
});

test("URL path supplies a name and keeps its extension", () => {
  assert.equal(
    suggestDownloadFileName(
      response({ url: "{{baseUrl}}/api/files", resolvedUrl: "https://host.test/files/archive.zip?token=1" }),
      "下载",
    ),
    "archive.zip",
  );
});

test("template URL segments fall back to the request name plus a mime extension", () => {
  assert.equal(
    suggestDownloadFileName(
      response({
        url: "{{baseUrl}}/export/{{id}}",
        headers: [{ name: "content-type", value: "application/pdf; charset=binary" }],
      }),
      "导出报表",
    ),
    "导出报表.pdf",
  );
});

test("illegal Windows characters are replaced and unknown binary types get .bin", () => {
  assert.equal(
    suggestDownloadFileName(
      response({ headers: [{ name: "content-type", value: "application/octet-stream" }] }),
      'a:b/c*d?"e',
    ),
    "c_d__e.bin",
  );
});

test("empty everything still yields a usable default", () => {
  assert.equal(suggestDownloadFileName(response(), ""), "download.bin");
});
