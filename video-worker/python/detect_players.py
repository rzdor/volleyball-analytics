"""
Player detection, tracking, and team grouping for volleyball videos.

Usage:
    python detect_players.py <video_path> <output_json_path> [options]

Options:
    --sample-fps       Frames per second to sample (default: 2)
    --confidence       Minimum detection confidence (default: 0.5)
    --num-teams        Number of teams to cluster (default: 2)
    --model            YOLO model name (default: yolov8n.pt)
"""

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from sklearn.cluster import KMeans
from ultralytics import YOLO

PERSON_CLASS_ID = 0
MAIN_TEAM_SIDE = "main"
OPPONENT_TEAM_SIDE = "opponent"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Detect and group volleyball players by team")
    parser.add_argument("video_path", help="Path to the input video file")
    parser.add_argument("output_path", help="Path for the output JSON file")
    parser.add_argument("--sample-fps", type=float, default=2.0, help="Frames per second to sample")
    parser.add_argument("--confidence", type=float, default=0.5, help="Minimum detection confidence")
    parser.add_argument("--num-teams", type=int, default=2, help="Number of teams to cluster")
    parser.add_argument("--model", type=str, default="yolov8n.pt", help="YOLO model name")
    return parser.parse_args()


def extract_jersey_color(frame: np.ndarray, bbox: tuple[int, int, int, int]) -> np.ndarray | None:
    """Extract dominant jersey color from the upper-body region of a detection.

    Crops the upper 40% of the bounding box (torso area), converts to HSV,
    and computes a normalized hue-saturation histogram as a color feature.
    """
    x1, y1, x2, y2 = bbox
    h = y2 - y1
    w = x2 - x1

    if h < 10 or w < 5:
        return None

    # Upper 40% of bbox = torso/jersey area
    torso_y2 = y1 + int(h * 0.4)
    # Inset horizontally by 15% to avoid arms/background
    inset_x = int(w * 0.15)
    crop = frame[y1:torso_y2, (x1 + inset_x):(x2 - inset_x)]

    if crop.size == 0:
        return None

    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)

    # 2D histogram: Hue (16 bins) x Saturation (8 bins)
    hist = cv2.calcHist([hsv], [0, 1], None, [16, 8], [0, 180, 0, 256])
    hist = cv2.normalize(hist, hist).flatten()
    return hist


def run_detection(
    video_path: str,
    model: YOLO,
    sample_fps: float,
    confidence: float,
) -> tuple[list[dict[str, Any]], dict[str, float]]:
    """Run YOLO tracking on the video and collect per-frame detections.

    Returns a list of raw frame results and video metadata.
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    video_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frame_interval = max(1, int(video_fps / sample_fps))

    metadata = {
        "videoFps": video_fps,
        "totalFrames": total_frames,
        "sampleFps": sample_fps,
        "frameInterval": frame_interval,
        "frameHeight": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        "frameWidth": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
    }

    raw_frames: list[dict[str, Any]] = []
    frame_idx = 0

    print(f"[detect] Processing video: {video_path}", file=sys.stderr)
    print(f"[detect] Video FPS: {video_fps}, Total frames: {total_frames}, Sample every {frame_interval} frames", file=sys.stderr)

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % frame_interval != 0:
            frame_idx += 1
            continue

        timestamp = frame_idx / video_fps

        # Run YOLO with ByteTrack tracker
        results = model.track(
            frame,
            persist=True,
            conf=confidence,
            classes=[PERSON_CLASS_ID],
            verbose=False,
            tracker="bytetrack.yaml",
        )

        frame_players = []
        result = results[0]

        if result.boxes is not None and len(result.boxes) > 0:
            boxes = result.boxes
            for i in range(len(boxes)):
                box = boxes[i]
                x1, y1, x2, y2 = box.xyxy[0].cpu().numpy().astype(int)
                conf = float(box.conf[0].cpu().numpy())
                track_id = int(box.id[0].cpu().numpy()) if box.id is not None else -1

                color_hist = extract_jersey_color(frame, (x1, y1, x2, y2))

                frame_players.append({
                    "trackId": track_id,
                    "bbox": {"x": int(x1), "y": int(y1), "w": int(x2 - x1), "h": int(y2 - y1)},
                    "confidence": round(conf, 3),
                    "colorHist": color_hist,
                    "jerseyColor": None,  # filled after clustering
                })

        raw_frames.append({
            "frameIndex": frame_idx,
            "timestamp": round(timestamp, 3),
            "players": frame_players,
        })

        frame_idx += 1

    cap.release()
    print(f"[detect] Sampled {len(raw_frames)} frames", file=sys.stderr)
    return raw_frames, metadata


def cluster_teams(
    raw_frames: list[dict[str, Any]],
    num_teams: int,
) -> dict[int, int]:
    """Cluster players into teams based on jersey color histograms.

    Aggregates color histograms per track ID, then runs K-means.
    Returns a mapping of trackId → teamId.
    """
    # Collect color features per track
    track_hists: dict[int, list[np.ndarray]] = {}
    for frame_data in raw_frames:
        for player in frame_data["players"]:
            tid = player["trackId"]
            if tid < 0 or player["colorHist"] is None:
                continue
            if tid not in track_hists:
                track_hists[tid] = []
            track_hists[tid].append(player["colorHist"])

    if len(track_hists) < num_teams:
        print(f"[detect] Warning: only {len(track_hists)} tracked players, less than {num_teams} teams", file=sys.stderr)
        return {tid: 0 for tid in track_hists}

    # Average histogram per track
    track_ids = sorted(track_hists.keys())
    features = np.array([np.mean(track_hists[tid], axis=0) for tid in track_ids])

    kmeans = KMeans(n_clusters=num_teams, random_state=42, n_init=10)
    labels = kmeans.fit_predict(features)

    track_team_map = {tid: int(label) for tid, label in zip(track_ids, labels)}

    for tid, team_id in track_team_map.items():
        print(f"[detect] Track {tid} → Team {team_id}", file=sys.stderr)

    return track_team_map


def infer_team_sides(
    raw_frames: list[dict[str, Any]],
    track_team_map: dict[int, int],
    num_teams: int,
    frame_height: int,
) -> dict[int, str]:
    """Infer semantic team sides from vertical player positions.

    Assumes the camera is behind the main team, so the main team tends to
    appear closer to the bottom of the frame while opponents appear higher up.
    """
    if frame_height <= 0:
        print("[detect] Warning: frame height unavailable; skipping team side inference", file=sys.stderr)
        return {}

    team_bottom_positions: dict[int, list[float]] = {team_id: [] for team_id in range(num_teams)}

    for frame_data in raw_frames:
        for player in frame_data["players"]:
            team_id = track_team_map.get(player["trackId"])
            if team_id is None or team_id < 0:
                continue

            bbox = player["bbox"]
            bottom_ratio = (bbox["y"] + bbox["h"]) / frame_height
            team_bottom_positions[team_id].append(bottom_ratio)

    ranked_teams = [
        (team_id, float(np.median(bottom_positions)))
        for team_id, bottom_positions in team_bottom_positions.items()
        if bottom_positions
    ]

    if len(ranked_teams) < 2:
        print("[detect] Warning: not enough team position data to infer main/opponent sides", file=sys.stderr)
        return {}

    ranked_teams.sort(key=lambda item: item[1], reverse=True)
    main_team_id = ranked_teams[0][0]
    opponent_team_id = ranked_teams[-1][0]

    team_side_map = {
        main_team_id: MAIN_TEAM_SIDE,
        opponent_team_id: OPPONENT_TEAM_SIDE,
    }

    for team_id, median_bottom_ratio in ranked_teams:
        inferred_side = team_side_map.get(team_id)
        if inferred_side:
            print(
                f"[detect] Team {team_id} inferred as {inferred_side} "
                f"(median bottom ratio {median_bottom_ratio:.3f})",
                file=sys.stderr,
            )

    return team_side_map


def compute_dominant_color(
    raw_frames: list[dict[str, Any]],
    track_team_map: dict[int, int],
    team_side_map: dict[int, str],
    video_path: str,
    sample_fps: float,
    num_teams: int,
) -> list[dict[str, Any]]:
    """Compute dominant BGR color per team by sampling player crops."""
    team_pixels: dict[int, list[np.ndarray]] = {i: [] for i in range(num_teams)}

    cap = cv2.VideoCapture(video_path)
    video_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_interval = max(1, int(video_fps / sample_fps))
    frame_idx = 0
    sample_count = 0

    while sample_count < 20:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % frame_interval != 0:
            frame_idx += 1
            continue

        # Find matching raw_frame data
        matching = [f for f in raw_frames if f["frameIndex"] == frame_idx]
        if matching:
            for player in matching[0]["players"]:
                tid = player["trackId"]
                if tid in track_team_map:
                    team_id = track_team_map[tid]
                    bbox = player["bbox"]
                    x, y, w, h = bbox["x"], bbox["y"], bbox["w"], bbox["h"]
                    torso_y2 = y + int(h * 0.4)
                    inset = int(w * 0.15)
                    crop = frame[y:torso_y2, (x + inset):(x + w - inset)]
                    if crop.size > 0:
                        team_pixels[team_id].append(crop.reshape(-1, 3))

        sample_count += 1
        frame_idx += 1

    cap.release()

    teams = []
    for team_id in range(num_teams):
        if team_pixels[team_id]:
            all_px = np.concatenate(team_pixels[team_id])
            # Use K-means on pixel colors to find dominant color
            km = KMeans(n_clusters=1, random_state=42, n_init=5)
            km.fit(all_px.astype(np.float32))
            bgr = km.cluster_centers_[0].astype(int)
            rgb = [int(bgr[2]), int(bgr[1]), int(bgr[0])]
        else:
            rgb = [128, 128, 128]

        player_count = sum(1 for tid, t in track_team_map.items() if t == team_id)
        teams.append({
            "id": team_id,
            "dominantColor": rgb,
            "playerCount": player_count,
            "side": team_side_map.get(team_id),
        })

    return teams


def build_output(
    raw_frames: list[dict[str, Any]],
    track_team_map: dict[int, int],
    team_side_map: dict[int, str],
    teams: list[dict[str, Any]],
    metadata: dict[str, float],
    video_name: str,
) -> dict[str, Any]:
    """Build the final JSON output structure."""
    # Build per-frame output (strip internal color histograms)
    frames_out = []
    for frame_data in raw_frames:
        players = []
        for p in frame_data["players"]:
            tid = p["trackId"]
            team_id = track_team_map.get(tid, -1)
            player_output = {
                "trackId": tid,
                "teamId": team_id,
                "bbox": p["bbox"],
                "confidence": p["confidence"],
            }

            team_side = team_side_map.get(team_id)
            if team_side:
                player_output["teamSide"] = team_side

            players.append(player_output)
        frames_out.append({
            "frameIndex": frame_data["frameIndex"],
            "timestamp": frame_data["timestamp"],
            "players": players,
        })

    # Build track summaries
    track_stats: dict[int, dict[str, Any]] = {}
    for frame_data in raw_frames:
        for p in frame_data["players"]:
            tid = p["trackId"]
            if tid < 0:
                continue
            if tid not in track_stats:
                track_stats[tid] = {
                    "trackId": tid,
                    "teamId": track_team_map.get(tid, -1),
                    "firstFrame": frame_data["frameIndex"],
                    "lastFrame": frame_data["frameIndex"],
                    "frameCount": 0,
                    "totalConfidence": 0.0,
                }
            track_stats[tid]["lastFrame"] = frame_data["frameIndex"]
            track_stats[tid]["frameCount"] += 1
            track_stats[tid]["totalConfidence"] += p["confidence"]

    tracks = []
    for tid in sorted(track_stats.keys()):
        s = track_stats[tid]
        track_output = {
            "trackId": s["trackId"],
            "teamId": s["teamId"],
            "firstFrame": s["firstFrame"],
            "lastFrame": s["lastFrame"],
            "frameCount": s["frameCount"],
            "avgConfidence": round(s["totalConfidence"] / max(s["frameCount"], 1), 3),
        }

        team_side = team_side_map.get(s["teamId"])
        if team_side:
            track_output["teamSide"] = team_side

        tracks.append(track_output)

    return {
        "videoName": video_name,
        "processedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sampleFps": metadata["sampleFps"],
        "videoFps": metadata["videoFps"],
        "totalVideoFrames": metadata["totalFrames"],
        "sampledFrames": len(frames_out),
        "teams": teams,
        "frames": frames_out,
        "tracks": tracks,
    }


def main() -> None:
    args = parse_args()

    video_path = args.video_path
    output_path = args.output_path

    if not Path(video_path).exists():
        print(f"Error: Video file not found: {video_path}", file=sys.stderr)
        sys.exit(1)

    print(f"[detect] Loading YOLO model: {args.model}", file=sys.stderr)
    model = YOLO(args.model)

    raw_frames, metadata = run_detection(
        video_path=video_path,
        model=model,
        sample_fps=args.sample_fps,
        confidence=args.confidence,
    )

    if not raw_frames:
        print("[detect] No frames sampled from video", file=sys.stderr)
        sys.exit(1)

    track_team_map = cluster_teams(raw_frames, args.num_teams)
    team_side_map = infer_team_sides(
        raw_frames=raw_frames,
        track_team_map=track_team_map,
        num_teams=args.num_teams,
        frame_height=int(metadata.get("frameHeight", 0)),
    )

    teams = compute_dominant_color(
        raw_frames=raw_frames,
        track_team_map=track_team_map,
        team_side_map=team_side_map,
        video_path=video_path,
        sample_fps=args.sample_fps,
        num_teams=args.num_teams,
    )

    video_name = Path(video_path).name
    output = build_output(raw_frames, track_team_map, team_side_map, teams, metadata, video_name)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"[detect] Results written to {output_path}", file=sys.stderr)
    print(f"[detect] Teams: {len(teams)}, Tracks: {len(output['tracks'])}, Frames: {len(output['frames'])}", file=sys.stderr)

    # Write path to stdout for the Node.js caller to capture
    print(output_path)


if __name__ == "__main__":
    main()
