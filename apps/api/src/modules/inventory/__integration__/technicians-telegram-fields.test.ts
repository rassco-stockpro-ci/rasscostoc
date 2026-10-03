import { describe, expect, it } from "vitest";
import { toMinimalTechnicianView } from "../presentation/controllers/technicians.controller";

describe("technicians API exposes the Telegram link facts", () => {
  const linkedAt = new Date("2026-10-03T02:30:00Z");
  const seenAt = new Date("2026-10-03T03:10:00Z");
  const base = { id: "u", username: "t", fullName: "T", role: "technician", isActive: true, password: "$2hash", permissions: null };

  it("linked technician", () => {
    const out = toMinimalTechnicianView({ ...base, telegramUserId: "700", telegramUsername: "tech_one", telegramLinkedAt: linkedAt, telegramLastSeenAt: seenAt });
    expect(out).toMatchObject({ telegramUserId: "700", telegramUsername: "tech_one", telegramLinked: true, telegramLinkedAt: linkedAt, telegramLastSeenAt: seenAt });
    expect(JSON.stringify(out)).not.toContain("$2hash");
  });

  it("unlinked technician reports not linked and no dates", () => {
    expect(toMinimalTechnicianView({ ...base, telegramUserId: null })).toMatchObject({
      telegramLinked: false, telegramUserId: null, telegramUsername: null, telegramLinkedAt: null, telegramLastSeenAt: null,
    });
  });
});
