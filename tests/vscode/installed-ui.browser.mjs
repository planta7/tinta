import { test, expect } from "@playwright/test";
import { chooseInstalledPath } from "../../scripts/vscode-installed-ui.mjs";

async function dialogFixture(page, { delayed = false, closes = true } = {}) {
  await page.setContent(`
    <div class="quick-input-widget">
      <div>Export HTML</div>
      <input type="text">
      <div role="listbox"></div>
    </div>
  `);
  await page.evaluate(
    ({ delayed, closes }) => {
      const dialog = document.querySelector(".quick-input-widget");
      const input = dialog.querySelector("input");
      window.chosenPath = null;
      window.earlyInput = false;
      let ready = false;
      input.addEventListener("input", () => {
        if (!ready) window.earlyInput = true;
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && ready && closes) {
          window.chosenPath = input.value;
          dialog.style.display = "none";
        }
      });
      const loaded = () => {
        input.value = "/initial/";
        dialog.querySelector("[role=listbox]").innerHTML =
          '<div role="option">..</div>';
        ready = true;
      };
      if (delayed) setTimeout(loaded, 200);
      else loaded();
    },
    { delayed, closes },
  );
}

test("installed file dialog waits for initialization before entering a path", async ({
  page,
}) => {
  await dialogFixture(page, { delayed: true });
  await chooseInstalledPath(page, "Export HTML", "/chosen/static.html");
  expect(await page.evaluate(() => window.earlyInput)).toBe(false);
  expect(await page.evaluate(() => window.chosenPath)).toBe(
    "/chosen/static.html",
  );
  await expect(page.locator(".quick-input-widget")).toBeHidden();
});

test("installed file dialog does not acknowledge Enter while the picker remains open", async ({
  page,
}) => {
  await dialogFixture(page, { closes: false });
  page.setDefaultTimeout(300);
  await expect(
    chooseInstalledPath(page, "Export HTML", "/chosen/static.html"),
  ).rejects.toThrow(/hidden/);
  await expect(page.locator(".quick-input-widget")).toBeVisible();
  expect(await page.evaluate(() => window.chosenPath)).toBeNull();
});

test("installed file dialog accepts an already initialized picker", async ({
  page,
}) => {
  await dialogFixture(page);
  await chooseInstalledPath(page, "Export HTML", "/chosen/");
  expect(await page.evaluate(() => window.chosenPath)).toBe("/chosen/");
});
