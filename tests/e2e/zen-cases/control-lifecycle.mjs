// The eval harness's own case, not Ego's. In Ego's suite the v2 control lifecycle
// (handOff, takeOverTaskSpace, waitForControl, userPage, ownership, finish
// with kept Pages, claimTaskSpace, adopt) is checked only inside "task spaces
// and control", which mostly tests legacy v1 helpers and is N/A for rubric A.
// This case checks the same v2 steps with the public API alone, following the
// "Starting and ending a reply" and "User control" sections of skill guide
// v2.2.1. It must pass on Ego to count.
export function v2ControlLifecycleCase() {
  return `
    const space = (id) => listTaskSpaces().then((all) => all.find((s) => s.id === id));
    const task = await taskSpace(taskName + " v2 control lifecycle");
    assertEqual(task.ownership, "agent", "a new task space is agent-controlled");
    await task.page("p1").goto(baseUrl + "/secondary?v2-control=1");
    assertEqual((await space(task.spaceId))?.ownership, "agent", "listTaskSpaces reports agent ownership");

    await task.handOff();
    assertEqual(
      (await space(task.spaceId))?.ownership,
      "agentDelegatedToUser",
      "handOff delegates the space to the user"
    );

    const resumed = await takeOverTaskSpace(task.spaceId);
    assertEqual(resumed.spaceId, task.spaceId, "takeOverTaskSpace resumes the same space");
    await resumed.waitForControl({ interval: 100, timeout: 5_000 });
    assertEqual((await space(task.spaceId))?.ownership, "agent", "takeover returns control to the agent");
    const boundary = resumed.userPage();
    assert(Boolean(boundary), "takeover captures the tab active at the user boundary");
    let kept = boundary.label;
    if (!kept) kept = (await resumed.adopt(boundary)).label;
    assertIncludes(await resumed.page(kept).url(), "/secondary?v2-control=1", "the boundary Page is the agent's page");

    const keepReceipt = await resumed.finish({ keep: [kept] });
    assertEqual(keepReceipt.spaceId, task.spaceId, "the finish receipt names its space");
    assertEqual(keepReceipt.closedSpace, false, "keeping a Page leaves the space open");
    assert(keepReceipt.keptManagedLabels.includes(kept), "the receipt lists the kept Page");
    assertEqual((await space(task.spaceId))?.ownership, "user", "a space finished with kept Pages belongs to the user");

    // The task ended, so on zenius this claim waits for the user's Allow
    // (SPEC §3.4). The runner answers it as the user would.
    const claimed = await claimTaskSpace(task.spaceId);
    assertEqual(claimed.spaceId, task.spaceId, "claimTaskSpace takes the finished space back");
    assertEqual((await space(task.spaceId))?.ownership, "agent", "a claimed space is agent-controlled again");
    const tabs = await claimed.tabs();
    assert(tabs.length >= 1, "the kept tab survives the finish");
    const keptTab = tabs.find((tab) => String(tab.url).includes("v2-control=1"));
    assert(keptTab && !keptTab.label, "after a claim the kept tab has no label yet");
    const adopted = await claimed.adopt(keptTab.page);
    assert(/^p\\d+$/.test(adopted.label), "adopt gives the kept tab a Page label");
    assertIncludes(await adopted.url(), "v2-control=1", "the adopted Page is the kept tab");

    const closeReceipt = await claimed.finish({ keep: [] });
    assertEqual(closeReceipt.closedSpace, true, "finish with keep [] closes the claimed space");
    for (let attempt = 0; attempt < 20 && (await space(task.spaceId)); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(!(await space(task.spaceId)), "the closed space leaves listTaskSpaces");
  `;
}
