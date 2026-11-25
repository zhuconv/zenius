<!-- Written from zenius's sources by sdk/scripts/write-references.ts: change those, then run it. -->

# Files

## In a script

page.screenshot({ path }), page.fetch()'s saveAs and download.saveAs() write the file the path names; page.setInputFiles() and fileChooser.setFiles() read the files their paths name and send the bytes. The CLI reads and writes these files, never Zen.

- The working folder, ~/zenius-files unless the install set another, is where a relative path lands, and where a finished download is: download.path() returns its path there, and it stays after the script ends. The files a run wrote there are listed after its output under [zenius:files].
- The plain CLI runs a script with the user's own access to files.
- The sandboxed CLI (zenius --version ends in sandboxed) keeps a script to a few folders. A script writes only to the working folder, process.env.ZENIUS_WORKING_DIR, and its temporary folder, never the folder it started in. A script reads files to upload only in the working folder, the folder it started in, its temporary folder and the folder the install lets scripts read (install-cli.sh --read-dir, such as ~/Downloads; process.env.ZENIUS_READ_DIR), and a link that leads outside them is refused too.
- An upload sends at most 50 MB in all. A folder's path uploads that one folder alone, at most 1,000 files.

### ZEN_PATH_NOT_ALLOWED

In the sandboxed CLI, a write outside the working folder and the temporary folder, or an upload of a file outside the working folder, the folder the command started in, the temporary folder and the folder the install lets scripts read (install-cli.sh --read-dir, such as ~/Downloads), or of a link to one. In either CLI, a working folder zenius can't use: one it can't make, or a config file that doesn't name it as the installer writes it.

Next: Give screenshot() and saveAs() a relative path, which lands in the working folder. For an upload, ask the user to copy the file into the working folder, or into the folder the message names that scripts may read. When the message is about the working folder itself, ask the user to run the installer again with --working-dir <folder>.

## Through the MCP tools

The MCP tools read and write no files: they offer no upload and no screenshot. A file a page downloads in the task lands in the working folder, and a later result says where, under which name, or why it failed. wait with downloads: true waits for the downloads still running, and finish refuses while one runs, since the task's end would cancel it, unless cancel_downloads is true.
