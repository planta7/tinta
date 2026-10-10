window.addEventListener("message", async (event) => {
  if (event.source !== parent || event.data?.kind !== "preview-test") return;
  const { id, action, value } = event.data;
  const result = { kind: "preview-test-result", id };
  try {
    const input = [...document.querySelectorAll('input[type="range"]')].at(-1);
    if (action === "control") {
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (action === "details") document.querySelector("details").open = true;
    if (action === "inspect") {
      result.text = document.body.textContent;
      result.controls = [...document.querySelectorAll("input,select")].map(
        (element) => ({
          value: element.value,
          disabled: element.disabled,
          label:
            element.labels?.[0]?.textContent ??
            element.getAttribute("aria-label"),
        }),
      );
      result.charts = document.querySelectorAll("figure").length;
      result.details = document.querySelector("details")?.open;
      result.inert = document.querySelector("main").inert;
      input?.focus();
      result.focused = document.activeElement === input;
      result.background = getComputedStyle(
        document.querySelector(".tinta-reader") ?? document.body,
      ).backgroundColor;
      result.color = getComputedStyle(
        document.querySelector(".tinta-reader") ?? document.body,
      ).color;
      result.scripts = document.querySelectorAll("script").length;
      result.externalImages = [...document.images].filter((image) =>
        /^https?:/.test(image.src),
      ).length;
    }
    if (action === "security") {
      for (const [name, check] of Object.entries({
        storage: () => localStorage.getItem("test"),
        parent: () => parent.document.body,
      })) {
        try {
          check();
          result[name] = false;
        } catch {
          result[name] = true;
        }
      }
      result.vscodeAbsent = typeof acquireVsCodeApi === "undefined";
      for (const [name, url] of [
        ["network", "https://example.invalid/preview-test"],
        ["file", "file:///etc/passwd"],
      ]) {
        try {
          await fetch(url);
          result[name] = false;
        } catch {
          result[name] = true;
        }
      }
      const anchor = [...document.querySelectorAll("a")].find((element) =>
        element.href.startsWith("https:"),
      );
      let activated = false;
      anchor?.addEventListener(
        "click",
        (event) => {
          activated = true;
          event.preventDefault();
        },
        { once: true },
      );
      anchor?.click();
      result.linkActivated = activated;
      result.linkTarget = anchor?.target;
      result.linkRel = anchor?.rel;
    }
    parent.postMessage(result, "*");
  } catch (error) {
    parent.postMessage({ ...result, error: String(error) }, "*");
  }
});
