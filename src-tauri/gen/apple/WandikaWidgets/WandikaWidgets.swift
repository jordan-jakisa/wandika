// Wandika's control and Live Activity: a Voice note button for Control Center, the Lock Screen
// and the Action button, and the recording's Live Activity with its Stop button.

import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct WandikaWidgets: WidgetBundle {
  var body: some Widget {
    VoiceNoteControl()
    VoiceNoteLiveActivity()
  }
}

struct VoiceNoteControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "me.jordanjakisa.wandika.voice-note") {
      ControlWidgetButton(action: StartVoiceNoteIntent()) {
        Label("Voice note", systemImage: "mic")
      }
    }
    .displayName("Voice note")
    .description("Speak a note into today's daily note, even from the Lock Screen.")
  }
}

/// Wandika's green (--papyrus in app.css).
private let accent = Color(red: 46 / 255, green: 106 / 255, blue: 78 / 255)

struct VoiceNoteLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: VoiceNoteAttributes.self) { context in
      LockScreenView(context: context)
        .padding(16)
        .activityBackgroundTint(nil)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Label("Voice note", systemImage: "mic.fill")
            .font(.headline)
            .foregroundStyle(context.state.listening ? .red : accent)
        }
        DynamicIslandExpandedRegion(.trailing) {
          if context.state.listening {
            Text(context.attributes.started, style: .timer)
              .monospacedDigit()
              .multilineTextAlignment(.trailing)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 8) {
            Text(words(context))
              .font(.body)
              .lineLimit(2)
              .frame(maxWidth: .infinity, alignment: .leading)
            if context.state.listening {
              Button(intent: StopVoiceNoteIntent()) {
                Label("Stop", systemImage: "stop.fill").frame(maxWidth: .infinity)
              }
              .tint(.red)
            }
          }
        }
      } compactLeading: {
        Image(systemName: "mic.fill").foregroundStyle(context.state.listening ? .red : accent)
      } compactTrailing: {
        if context.state.listening {
          Text(context.attributes.started, style: .timer).monospacedDigit().frame(maxWidth: 44)
        } else {
          Image(systemName: "checkmark").foregroundStyle(accent)
        }
      } minimal: {
        Image(systemName: "mic.fill").foregroundStyle(context.state.listening ? .red : accent)
      }
    }
  }
}

private func words(_ context: ActivityViewContext<VoiceNoteAttributes>) -> String {
  if !context.state.text.isEmpty { return context.state.text }
  return context.state.listening ? "Listening. Speak now." : ""
}

private struct LockScreenView: View {
  let context: ActivityViewContext<VoiceNoteAttributes>

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Label("Voice note", systemImage: "mic.fill")
          .font(.headline)
          .foregroundStyle(context.state.listening ? .red : accent)
        Spacer()
        if context.state.listening {
          Text(context.attributes.started, style: .timer)
            .font(.headline)
            .monospacedDigit()
            .multilineTextAlignment(.trailing)
        }
      }
      Text(words(context))
        .font(.body)
        .lineLimit(3)
        .frame(maxWidth: .infinity, alignment: .leading)
      if context.state.listening {
        Button(intent: StopVoiceNoteIntent()) {
          Label("Stop", systemImage: "stop.fill").frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(.red)
      }
    }
  }
}
