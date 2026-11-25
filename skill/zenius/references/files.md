<!-- Written from zenius's sources by sdk/scripts/write-references.ts: change those, then run it. -->

# Files

## In a script

page.screenshot({ path }), page.fetch()'s saveAs and download.saveAs() write the file the path names; page.setInputFiles() and fileChooser.setFiles() read the files their paths name and send the bytes. The CLI reads and writes these files, never Zen.

- The plain CLI runs a script with the user's own access to files. Give absolute paths, as in Ego.
- The sandboxed CLI (zenius --version ends in sandboxed) keeps a script to a few folders. A script writes only to its output folder, process.env.ZENIUS_OUTPUT_DIR, and its temporary folder, never its working folder. A relative path lands in the output folder, the files a run wrote are listed after its output under [zenius:files], and a run's output folder is kept 7 days. A script reads files to upload only in its working folder, its runs' output folders, its temporary folder and the folder the install lets scripts read (install-cli.sh --read-dir, such as ~/Downloads; process.env.ZENIUS_READ_DIR), and a link that leads outside them is refused too.
- An upload sends at most 50 MB in all. A folder's path uploads that one folder alone, at most 1,000 files.

### ZEN_PATH_NOT_ALLOWED

In the sandboxed CLI, a write outside the run's output and temporary folders, or an upload of a file outside the working folder, the runs' output folders, the temporary folder and the folder the install lets scripts read (install-cli.sh --read-dir, such as ~/Downloads), or of a link to one.

Next: Give screenshot() and saveAs() a relative path, which lands in the output folder. For an upload, ask the user to copy the file into the working folder, or into the folder the message names that scripts may read.

## Through the MCP tools

The MCP tools read and write no files: they offer no upload, no download and no screenshot.
