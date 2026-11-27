# ADR 0010: Assign one owner to each workbench workflow

Status: Independently approved design. Implementation verification is tracked
in [remediation batch 3](../design/review-remediation-plan.md#3-simplify-the-workbench-with-behavior-pinned).

The renderer gives project changes and Quit one exclusive reservation. Cancel
keeps the previous project and its processes; native success is the cutover
point, and setup errors after it do not roll back to the old workspace ID.
File operations retain their individual document state.

Go task and Debug launch share a separate tokenized lane and save barrier.
The barrier requires unchanged edit revision and a clean result. A task Stop
holds the lane until its native command settles even if the task finishes
first, because the command addresses a workspace slot, not a task ID. A
debug session similarly holds its lane until native admission and cleanup
have settled. Renderer effects check their token at the site of application;
native workspace and subprocess ownership remain in Rust.
