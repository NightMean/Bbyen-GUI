import contextlib
import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import bbyen_add_sub_whitelist_only as manager


CHANNEL = "UC0000000000000000000000"
OTHER = "UC1111111111111111111111"


class ChannelManagementTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="bbyen-channels-test-")
        self.addCleanup(self.directory.cleanup)
        self.filename = os.path.join(self.directory.name, "channels.json")
        self.enterContext(patch.object(manager, "TARGET_CHANNELS_FILE", self.filename))
        self.restart = self.enterContext(patch.object(manager, "restart_service"))
        self.output = self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def write(self, entries):
        with open(self.filename, "w", encoding="utf-8") as target:
            json.dump({"whitelistedChannelIds": entries, "blacklistedChannelIds": [OTHER]}, target)

    def read(self):
        with open(self.filename, encoding="utf-8") as source:
            return json.load(source)

    def test_removes_string_and_object_duplicates_preserving_other_settings(self):
        preserved = {"id": OTHER, "notify": False, "notifyOnFirstScan": False}
        self.write([CHANNEL, {"id": CHANNEL, "notify": False}, preserved])
        manager.remove_channel(CHANNEL)
        self.assertEqual(self.read()["whitelistedChannelIds"], [preserved])
        self.assertEqual(self.read()["blacklistedChannelIds"], [OTHER])
        self.restart.assert_called_once()

    def test_add_does_not_duplicate_normalized_channel(self):
        entry = {"id": CHANNEL, "notify": False}
        self.write([entry])
        manager.add_channel(CHANNEL)
        self.assertEqual(self.read()["whitelistedChannelIds"], [entry])
        self.restart.assert_not_called()

    def test_lists_ids_from_both_entry_formats(self):
        self.write([CHANNEL, {"id": OTHER, "notify": False}])
        manager.list_channels()
        self.assertIn("/channel/" + OTHER, self.output.getvalue())
        self.assertNotIn("{'id':", self.output.getvalue())

    def test_explicit_channels_path_can_be_new(self):
        with patch.dict(os.environ, {"BBYEN_CHANNELS": self.filename}):
            self.assertEqual(manager.find_channels_file(), self.filename)


if __name__ == "__main__":
    unittest.main()
