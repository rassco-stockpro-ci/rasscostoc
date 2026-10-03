import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TelegramLinkStatus } from "./telegram-link-status";

describe("TelegramLinkStatus — what the user-details screen shows for a linked technician", () => {
  it("shows ID, @username, status, link date and last Telegram use, all from the API fields", () => {
    render(
      <TelegramLinkStatus
        user={{
          telegramUserId: "700123456",
          telegramUsername: "tech_one",
          telegramLinked: true,
          telegramLinkedAt: "2026-10-03T02:30:00.000Z",
          telegramLastSeenAt: "2026-10-03T03:10:00.000Z",
        }}
      />
    );
    expect(screen.getByTestId("tg-status").textContent).toContain("مربوط");
    expect(screen.getByTestId("tg-id").textContent).toContain("700123456");
    expect(screen.getByTestId("tg-username").textContent).toContain("@tech_one");
    expect(screen.getByTestId("tg-linked-at").textContent).not.toContain("غير مسجل");
    expect(screen.getByTestId("tg-last-seen").textContent).not.toContain("لم يستخدم");
  });

  it("never invents what was not recorded (an admin-linked account from before self-link)", () => {
    render(<TelegramLinkStatus user={{ telegramUserId: "42424242", telegramUsername: null, telegramLinked: true, telegramLinkedAt: null, telegramLastSeenAt: null }} />);
    expect(screen.getByTestId("tg-username").textContent).toContain("غير مسجل");
    expect(screen.getByTestId("tg-linked-at").textContent).toContain("غير مسجل");
    expect(screen.getByTestId("tg-last-seen").textContent).toContain("لم يستخدم البوت بعد");
  });

  it("an unreadable date is shown as not recorded, not as 'Invalid Date'", () => {
    render(<TelegramLinkStatus user={{ telegramUserId: "1234567", telegramLinked: true, telegramLinkedAt: "garbage" }} />);
    expect(screen.getByTestId("tg-linked-at").textContent).toContain("غير مسجل");
    expect(document.body.textContent).not.toContain("Invalid");
  });

  it("renders nothing for an unlinked user", () => {
    const { container } = render(<TelegramLinkStatus user={{ telegramUserId: null, telegramLinked: false }} />);
    expect(container.firstChild).toBeNull();
  });

  it("an older API response without the new fields still renders as linked", () => {
    render(<TelegramLinkStatus user={{ telegramUserId: "7001234" }} />);
    expect(screen.getByTestId("tg-status").textContent).toContain("مربوط");
  });
});
