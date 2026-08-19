import test from "node:test";
import assert from "node:assert/strict";
import {
  GmailSendSafetyError,
  isGmailAccountSendingLimitNotice,
  isGmailMailSendingLimitError,
} from "../src/lib/gmail-send-safety.js";
import { AppSettingsPatchSchema } from "../src/lib/settings.js";

test("recognizes direct Gmail mail-sending quota errors", () => {
  assert.equal(isGmailMailSendingLimitError(new Error("Gmail API failed (429): User-rate limit exceeded (Mail sending)")), true);
  assert.equal(isGmailMailSendingLimitError(new Error("421 4.7.28 Gmail temporarily rate limited")), true);
  assert.equal(isGmailMailSendingLimitError(new Error("Gmail API failed (503): backend unavailable")), false);
});

test("recognizes Google's account-level sending-limit delivery notice", () => {
  assert.equal(isGmailAccountSendingLimitNotice({
    from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
    subject: "Re: Quick Question",
    text: "You have reached a limit for sending mail. Your message was not sent.",
  }), true);

  assert.equal(isGmailAccountSendingLimitNotice({
    from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
    subject: "Delivery Status Notification (Failure)",
    text: "The email account that you tried to reach does not exist.",
  }), false);

  assert.equal(isGmailAccountSendingLimitNotice({
    from: "prospect@example.com",
    subject: "Re: Quick Question",
    text: "You have reached a limit for sending mail.",
  }), false);
});

test("Gmail send-safety settings use the canonical AppSettings schema", () => {
  assert.deepEqual(AppSettingsPatchSchema.parse({
    gmailRolling24hSafetyLimit: 100,
    minimumSendIntervalMinutes: 10,
    gmailQuotaCooldownHours: 24,
  }), {
    gmailRolling24hSafetyLimit: 100,
    minimumSendIntervalMinutes: 10,
    gmailQuotaCooldownHours: 24,
  });
  assert.throws(() => AppSettingsPatchSchema.parse({ gmailRolling24hSafetyLimit: 0 }));
  assert.throws(() => AppSettingsPatchSchema.parse({ minimumSendIntervalMinutes: 0 }));
  assert.throws(() => AppSettingsPatchSchema.parse({ gmailQuotaCooldownHours: 73 }));
});

test("Gmail send safety errors retain machine-readable deferral state", () => {
  const retryAt = new Date("2026-08-20T12:00:00.000Z");
  const error = new GmailSendSafetyError("cooldown", "gmail_quota_cooldown", retryAt);
  assert.equal(error.code, "gmail_quota_cooldown");
  assert.equal(error.retryAt, retryAt);
});
