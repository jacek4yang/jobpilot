import { expect, test } from "@playwright/test";
import { HOST_MAPPING_ARGS, loadHarness, GUARDED_ORIGIN, SERVER_ORIGIN } from "./harness";
test.use({ launchOptions: { args: HOST_MAPPING_ARGS } });
// Re-implement isSupportedHost's rule and confirm it holds for the origins we use.
const supported = (href: string) => {
  try { return ["zhipin.com","www.zhipin.com"].includes(new URL(href).hostname.toLowerCase()); }
  catch { return false; }
};
test("origin classification matches the adapter guard", async ({ page }) => {
  await loadHarness(page, "job-list.html");
  const guarded = page.url();
  await loadHarness(page, "job-list.html", { origin: SERVER_ORIGIN });
  const plain = page.url();
  console.log("guarded:", guarded, "supported=", supported(guarded));
  console.log("plain  :", plain,   "supported=", supported(plain));
  expect(supported(guarded)).toBe(true);
  expect(supported(plain)).toBe(false);
});
