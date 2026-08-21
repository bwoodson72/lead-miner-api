const apiUrl = (process.env.LEAD_MINER_API_URL ?? "").trim().replace(/\/$/, "");
const cronSecret = (process.env.CRON_SECRET ?? "").trim();

if (!apiUrl) {
  console.error("Missing LEAD_MINER_API_URL");
  process.exit(1);
}

if (!cronSecret) {
  console.error("Missing CRON_SECRET");
  process.exit(1);
}

const endpoint = `${apiUrl}/api/automation/tick`;

try {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cronSecret}`,
      "Content-Type": "application/json",
    },
  });

  const body = await response.text();
  if (body) console.log(body);

  if (response.status === 409) {
    console.log("Automation tick is already running; leaving the active worker in control.");
    process.exit(0);
  }

  if (!response.ok) {
    console.error(`Automation tick failed with HTTP ${response.status}`);
    process.exit(1);
  }

  console.log(`Automation tick completed with HTTP ${response.status}.`);
} catch (error) {
  console.error("Automation tick request failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
