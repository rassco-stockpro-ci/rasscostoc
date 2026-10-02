"""
Telegram-bot end-to-end harness (test support for telegram-bot-e2e.test.ts).

Imports the REAL bot module (the file under BOT_MODULE_PATH — the deployed
installation_bot.py, or a staged copy) and calls its real integration
function, push_session_to_rassco(), exactly as finalize_session does after a
technician finishes a documentation session:

    gate (serial-lookup per device/SIM, request match, technician)
      -> POST /api/courier/pdf/{id}/update-extracted
      -> POST /api/courier/pdf/{id}/complete      (devices[] cards)
      -> the Arabic lines the technician sees on Telegram

Only the environment is substituted: the RASSCO API points at the backend
under test, STOCKPRO_DB_URL at its isolated test database, and the Google
clients are given dummy credentials (they are built at import, never called).

stdin : JSON { "request_number", "telegram_user_id", "report_id", "devices": [
          { "sn", "iccid", "tid", "has_sim" } ] }
stdout: one JSON line { "lines": [...], "gate_ok": bool, "error": str|null }
"""
import importlib.util
import json
import os
import sys

module_path = os.environ["BOT_MODULE_PATH"]
sys.path.insert(0, os.path.dirname(module_path))

# Dummy credentials: construction only, no Google call is ever made by this path.
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "e2e-not-a-real-token")
os.environ.setdefault("GOOGLE_SERVICE_ACCOUNT_JSON", "/dev/null")
os.environ.setdefault("GEMINI_API_KEY", "e2e-not-a-real-key")
os.environ.setdefault("GOOGLE_OAUTH_CLIENT_ID", "e2e-client")
os.environ.setdefault("GOOGLE_OAUTH_CLIENT_SECRET", "e2e-secret")
os.environ.setdefault("GOOGLE_OAUTH_REFRESH_TOKEN", "e2e-refresh")
os.environ.setdefault("REQUIRE_AUTHORIZED_TECHNICIAN", "true")

spec = importlib.util.spec_from_file_location("installation_bot_under_test", module_path)
bot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bot)

payload = json.load(sys.stdin)
devices = []
for d in payload["devices"]:
    devices.append(
        bot.DeviceCapture(
            device_image={"extracted": {"serial_number": d["sn"]}, "reading_status": None},
            sim_image={"extracted": {"iccid": d.get("iccid")}} if d.get("has_sim", True) else None,
            proof_image={"extracted": {"terminal_id": d.get("tid")}},
            has_sim=d.get("has_sim", True),
        )
    )

session = bot.Session(
    telegram_user_id=str(payload["telegram_user_id"]),
    telegram_username="e2e_technician",
    request_number_input=str(payload["request_number"]),
    devices=devices,
    rassco_report_id=str(payload["report_id"]),
)

out = {"lines": [], "gate_ok": None, "error": None, "complete": None}
try:
    matched = bot.match_request_by_number(session.request_number_input)
    if not matched:
        out["error"] = "request not matched by the bot"
    elif payload.get("mode") == "complete_only":
        # The bot's own HTTP call to the close endpoint, WITHOUT its local gate:
        # proves the backend validates again and refuses on its own.
        cards = [
            {
                "sn": d["sn"],
                "sim_serial": d.get("iccid"),
                "tid": d.get("tid"),
                "technician_code": None,
                **({"sim_waived": True} if not d.get("has_sim", True) else {}),
            }
            for d in payload["devices"]
        ]
        out["complete"] = bot.complete_rassco_courier_report(
            session.rassco_report_id, matched["id"], cards, telegram_user_id=session.telegram_user_id
        )
    else:
        out["gate_ok"] = bot.validate_session_for_rassco(session).ok
        out["lines"] = bot.push_session_to_rassco(session, matched)
except Exception as e:  # the bot itself never raises out of push_session_to_rassco
    out["error"] = f"{type(e).__name__}: {e}"
sys.stdout.write("\n" + json.dumps(out, ensure_ascii=False) + "\n")
