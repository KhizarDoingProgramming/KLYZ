import { describe, expect, it } from "vitest";
import { capabilityCatalog, capabilityCatalogJson, capabilityDigest, capabilityFor } from "./catalog";
import { NODE_DEFINITIONS } from "@/lib/workflow/registry";

/**
 * The catalog is the only thing the model is told about KLYZ's
 * capabilities, so it has to be a faithful projection of the registry —
 * drift here is how invented node types get into plans.
 */

describe("capabilityCatalog", () => {
  it("covers every registered node type, exactly once", () => {
    const capabilities = capabilityCatalog();
    const registryTypes = Object.values(NODE_DEFINITIONS)
      .map((definition) => definition.type)
      .sort();
    const catalogTypes = capabilities.map((capability) => capability.type).sort();
    expect(catalogTypes).toEqual(registryTypes);
    expect(new Set(catalogTypes).size).toBe(catalogTypes.length);
  });

  it("projects registry fields rather than inventing them", () => {
    for (const capability of capabilityCatalog()) {
      const definition = NODE_DEFINITIONS[capability.type]!;
      expect(capability.title).toBe(definition.title);
      expect(capability.category).toBe(definition.category);
      expect(capability.purpose).toBe(definition.description.slice(0, 200));
      expect(capability.summary).toBe(definition.summary.slice(0, 200));
      expect(capability.trigger).toBe(definition.trigger === true);
      expect(capability.cost).toBe(definition.cost);
      expect(capability.requires.map((field) => field.key)).toEqual(
        definition.fields.filter((field) => field.required).map((field) => field.key),
      );
      expect(capability.optional.map((field) => field.key)).toEqual(
        definition.fields.filter((field) => !field.required).map((field) => field.key),
      );
      expect(capability.outputs).toEqual(
        definition.outputs.flatMap((output) =>
          output.children?.length
            ? [output.key, ...output.children.map((child) => `${output.key}.${child.key}`)]
            : [output.key],
        ),
      );
    }
  });

  it("never leaks a credential id — integrations are named, not identified", () => {
    for (const capability of capabilityCatalog()) {
      const serialized = JSON.stringify(capability);
      expect(serialized).not.toMatch(/"credentialId"/);
      expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
      if (capability.credentials?.length) {
        expect(capability.credentials.length).toBeGreaterThan(0);
      }
    }
  });

  it("is deterministic: same digest on every call and module state", () => {
    const first = capabilityDigest();
    const second = capabilityDigest();
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16,64}$/);
    expect(JSON.parse(capabilityCatalogJson())).toHaveLength(Object.keys(NODE_DEFINITIONS).length);
  });

  it("looks types up individually and misses cleanly", () => {
    expect(capabilityFor("action.slack_message")?.title).toBe("Slack message");
    expect(capabilityFor("action.made_up")).toBeUndefined();
    expect(capabilityFor("__proto__")).toBeUndefined();
  });
});
