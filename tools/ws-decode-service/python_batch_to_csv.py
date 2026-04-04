import argparse
import base64
import csv
import json
from pathlib import Path

import requests


def load_input(path: Path) -> dict[str, list[str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "data" in data and isinstance(data["data"], dict):
        data = data["data"]

    if not isinstance(data, dict):
        raise ValueError("input json must be an object: {phone: [base64_or_hex,...]}")

    normalized: dict[str, list[str]] = {}
    for phone, frames in data.items():
        if not isinstance(frames, list):
            continue

        out_frames: list[str] = []
        for frame in frames:
            if isinstance(frame, str):
                f = frame.strip()
                if not f:
                    continue
                # If it looks like hex bytes, convert to base64.
                if all(ch in "0123456789abcdefABCDEF" for ch in f) and len(f) % 2 == 0:
                    out_frames.append(base64.b64encode(bytes.fromhex(f)).decode("ascii"))
                else:
                    out_frames.append(f)
            elif isinstance(frame, list):
                raw = bytes(frame)
                out_frames.append(base64.b64encode(raw).decode("ascii"))
        if out_frames:
            normalized[str(phone)] = out_frames

    return normalized


def decode_batch(base_url: str, payload: dict[str, list[str]]) -> dict:
    resp = requests.post(
        f"{base_url}/decode-batch",
        json={"data": payload, "includeRaw": False},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def write_csv(result: dict, output_csv: Path) -> None:
    rows = []
    for item in result.get("results", []):
        rows.append(
            {
                "phone": item.get("phone") or "",
                "activity": item.get("activity") or "not_exist",
                "total_frames": item.get("totalFrames", 0),
                "decoded_frames": item.get("decodedFrames", 0),
            }
        )

    with output_csv.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["phone", "activity", "total_frames", "decoded_frames"],
        )
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Batch decode ws frames and export csv")
    parser.add_argument("--input", required=True, help="input json path")
    parser.add_argument("--output", default="ws_activity.csv", help="output csv path")
    parser.add_argument("--base-url", default="http://127.0.0.1:3000", help="decode service base url")

    args = parser.parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)

    payload = load_input(input_path)
    if not payload:
        raise SystemExit("no valid phone/frame data found in input")

    result = decode_batch(args.base_url, payload)
    write_csv(result, output_path)

    print(f"CSV generated: {output_path}")
    print(f"total_numbers: {result.get('totalNumbers', 0)}")


if __name__ == "__main__":
    main()
