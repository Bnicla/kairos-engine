import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE, markdownResumeToDocx } from "@kairos/engine/docx-render";
import { resumeLengthPolicy } from "@kairos/engine/length-policy";
import { parseDocxTemplate } from "../apps/cloud/lib/template-parse";
import type { Experience } from "@kairos/engine/kb/types";

const MD = `# Jane Doe
Boston · jane@example.com

## Professional Experience

### Acme | Boston
#### Product Manager | 2020 – 2022

- **Shipped:** Delivered the thing on time.
`;

describe("TemplateSpec seam (DEC-8)", () => {
  it("renders identically-shaped output with no template (local-lane default)", async () => {
    const buf = await markdownResumeToDocx(MD);
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("round-trips design overrides: render with a custom template, parse it back", async () => {
    const custom = { font: "Georgia", base: 24, pageMarginTwips: 1440, ink: "1A2B3C" };
    const rendered = await markdownResumeToDocx(MD, { template: custom });
    const parsed = await parseDocxTemplate(rendered);
    expect(parsed.overrides.font).toBe("Georgia");
    expect(parsed.overrides.base).toBe(24);
    expect(parsed.overrides.pageMarginTwips).toBe(1440);
    expect(parsed.overrides.ink).toBe("1A2B3C");
    expect(parsed.detected.length).toBeGreaterThanOrEqual(3);
  });

  it("leaves unknown/implausible values to the default (sanity bounds)", async () => {
    const rendered = await markdownResumeToDocx(MD, { template: { base: 200 } }); // absurd 100pt
    const parsed = await parseDocxTemplate(rendered);
    expect(parsed.overrides.base).toBeUndefined();
    expect(DEFAULT_TEMPLATE.base).toBe(21); // the calibrated default is untouched
  });
});

const exp = (start: string, end: string): Experience =>
  ({ fileName: "x.md", frontmatter: { id: "x", company: "C", title: "T", start, end }, body: "" }) as unknown as Experience;

describe("resumeLengthPolicy (DEC-9)", () => {
  it("targets 1 page for early career, 2 for senior", () => {
    expect(resumeLengthPolicy([exp("2023", "present")], { nowYear: 2026 }).targetPages).toBe(1);
    expect(resumeLengthPolicy([exp("2010", "2012"), exp("2012", "present")], { nowYear: 2026 }).targetPages).toBe(2);
  });

  it("honors a user override", () => {
    expect(resumeLengthPolicy([exp("2023", "present")], { nowYear: 2026, override: 2 }).targetPages).toBe(2);
  });
});
