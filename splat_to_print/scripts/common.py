"""Shared paths. Run every script from <project>/print/ (outputs go to ./work and ./renders),
or set SPLAT_PROJECT=/path/to/projects/NAME."""
import os
PROJECT = os.path.abspath(os.environ.get("SPLAT_PROJECT") or os.path.dirname(os.getcwd()))
SPLAT = os.path.join(PROJECT, "splat", "splat_30000.ply")
CAMERA_PATH = os.path.join(PROJECT, "camera_path.json")
DATASET_IMAGES = os.path.join(PROJECT, "dataset", "images")
SPARSE = os.path.join(PROJECT, "dataset", "sparse", "0")
os.makedirs("work", exist_ok=True); os.makedirs("renders", exist_ok=True)
