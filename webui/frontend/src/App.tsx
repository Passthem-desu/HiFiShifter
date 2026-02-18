import { useEffect } from "react";
import { useAppDispatch } from "./app/hooks";
import { refreshRuntime } from "./features/session/sessionSlice";
import { TopControlsBar } from "./components/layout/TopControlsBar";
import { ActionBar } from "./components/layout/ActionBar";
import { TimelinePanel } from "./components/editor/TimelinePanel";
import { PianoRollPanel } from "./components/editor/PianoRollPanel";
import { StatusPanels } from "./components/layout/StatusPanels";

function App() {
    const dispatch = useAppDispatch();

    useEffect(() => {
        dispatch(refreshRuntime());
    }, [dispatch]);

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100">
            <div className="mx-auto max-w-[1400px] p-4">
                <h1 className="mb-3 text-2xl font-semibold">HiFiShifter</h1>

                <TopControlsBar />
                <ActionBar />

                <div className="mt-3">
                    <TimelinePanel />
                    <PianoRollPanel />
                </div>

                <StatusPanels />
            </div>
        </div>
    );
}

export default App;
