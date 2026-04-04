import base64
import requests


def decode_frames(decoded_frames: list[bytes], base_url: str = "http://127.0.0.1:3000") -> dict:
    frames_base64 = [base64.b64encode(frame).decode("ascii") for frame in decoded_frames]

    resp = requests.post(
        f"{base_url}/decode",
        json={"frames": frames_base64, "includeRaw": False},
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()


if __name__ == "__main__":
    # Replace with your real ws frame bytes captured from Playwright/robot.
    sample_frames = [
        b"\x08\x12\x1a\x00",
        b"\x0a\x0b\x12\x00",
    ]

    data = decode_frames(sample_frames)
    print("decode result:")
    print(data)
    print("overall activity:", data.get("activity", "not_exist"))

    for item in data.get("results", []):
        if item.get("exists"):
            activity = item.get("activity", "low_active")
            msg_type = item.get("type", "other")
            print(
                f"[frame {item['index']}] exists=true activity={activity} type={msg_type}"
            )
        else:
            print(f"[frame {item['index']}] decode failed: {item.get('error')}")
