# Smart Hospital Emergency Triage System (OS Mini-Project)

Multithreading-based simulation of a hospital emergency department, built for the Operating Systems mini-project.

**Live demo:** https://vedantcodx.github.io/os_project/

## Features
- Patient arrival generator, dispatcher and doctor threads (logical threads on a virtual clock)
- Scheduling policies: first come first served, strict priority, priority + aging
- Counting semaphores for ICU beds, ventilators and the X-ray unit, acquired in a fixed order to avoid deadlock
- Fault injection with heartbeat detection and safe re-queuing
- Policy comparison on identical workloads, CSV export
- Race condition lab (with and without a mutex)

## Run locally
Open `index.html` in any browser. No install or server needed.

## Files
- `index.html` page structure
- `style.css` styling (light and dark theme)
- `app.js` simulation engine, UI rendering, comparison and race lab

Educational simulation with synthetic patients; not for clinical use.
