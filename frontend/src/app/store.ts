import { configureStore } from '@reduxjs/toolkit'
import sessionReducer from '../features/session/sessionSlice'
import fileBrowserReducer from '../features/fileBrowser/fileBrowserSlice'

export const store = configureStore({
  reducer: {
    session: sessionReducer,
    fileBrowser: fileBrowserReducer,
  },
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
