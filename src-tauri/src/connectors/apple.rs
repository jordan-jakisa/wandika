//! Apple Calendar and Reminders through EventKit, on the device itself (Mac and iPhone).
//! All calls block on EventKit and must run off the main thread.

use super::{CalEvent, RemoteTask};
use crate::error::Result;
use serde::Serialize;

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    /// Android: EventKit doesn't exist there.
    #[cfg_attr(any(target_os = "macos", target_os = "ios"), allow(dead_code))]
    Unsupported,
    NotAsked,
    Granted,
    Denied,
}

#[derive(Clone, Copy)]
pub enum Kind {
    Calendar,
    Reminders,
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
    use super::*;
    use crate::error::msg;
    use block2::RcBlock;
    use chrono::{DateTime, Local, Utc};
    use objc2::rc::Retained;
    use objc2::runtime::Bool;
    use objc2_event_kit::{EKAuthorizationStatus, EKEntityType, EKEventStore, EKReminder};
    use objc2_foundation::{NSArray, NSDate, NSError, NSString};
    use std::sync::mpsc;
    use std::time::Duration;

    fn entity(kind: Kind) -> EKEntityType {
        match kind {
            Kind::Calendar => EKEntityType::Event,
            Kind::Reminders => EKEntityType::Reminder,
        }
    }

    pub fn access(kind: Kind) -> Access {
        let status = unsafe { EKEventStore::authorizationStatusForEntityType(entity(kind)) };
        if status == EKAuthorizationStatus::FullAccess {
            Access::Granted
        } else if status == EKAuthorizationStatus::NotDetermined {
            Access::NotAsked
        } else {
            Access::Denied
        }
    }

    pub fn request(kind: Kind) -> Result<Access> {
        if access(kind) != Access::NotAsked {
            return Ok(access(kind));
        }
        let store = unsafe { EKEventStore::new() };
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |granted: Bool, _err: *mut NSError| {
            let _ = tx.send(granted.as_bool());
        });
        unsafe {
            match kind {
                Kind::Calendar => store.requestFullAccessToEventsWithCompletion(RcBlock::as_ptr(&block)),
                Kind::Reminders => store.requestFullAccessToRemindersWithCompletion(RcBlock::as_ptr(&block)),
            }
        }
        let granted = rx.recv_timeout(Duration::from_secs(300)).unwrap_or(false);
        Ok(if granted { Access::Granted } else { Access::Denied })
    }

    fn date(ts: DateTime<Utc>) -> Retained<NSDate> {
        NSDate::dateWithTimeIntervalSince1970(ts.timestamp() as f64)
    }

    fn rfc3339(d: &NSDate) -> String {
        let secs = d.timeIntervalSince1970();
        DateTime::from_timestamp(secs as i64, 0)
            .map(|t| t.with_timezone(&Local).to_rfc3339())
            .unwrap_or_default()
    }

    pub fn events(from: DateTime<Utc>, to: DateTime<Utc>) -> Result<Vec<CalEvent>> {
        if access(Kind::Calendar) != Access::Granted {
            return Ok(Vec::new());
        }
        let store = unsafe { EKEventStore::new() };
        let pred = unsafe { store.predicateForEventsWithStartDate_endDate_calendars(&date(from), &date(to), None) };
        let found = unsafe { store.eventsMatchingPredicate(&pred) };
        let mut out = Vec::new();
        for i in 0..found.count() {
            let e = found.objectAtIndex(i);
            unsafe {
                let all_day = e.isAllDay();
                let (start, end) = (rfc3339(&e.startDate()), rfc3339(&e.endDate()));
                out.push(CalEvent {
                    id: e.eventIdentifier().map(|s| s.to_string()).unwrap_or_default(),
                    source: "apple".into(),
                    calendar: e.calendar().map(|c| c.title().to_string()).unwrap_or_else(|| "Calendar".into()),
                    title: e.title().to_string(),
                    start: if all_day { start.chars().take(10).collect::<String>() + "T00:00:00" } else { start },
                    end,
                    all_day,
                    location: e.location().map(|s| s.to_string()).filter(|s| !s.is_empty()),
                    url: e.URL().and_then(|u| u.absoluteString()).map(|s| s.to_string()),
                    attendees: e
                        .attendees()
                        .map(|a| (0..a.count()).filter_map(|j| a.objectAtIndex(j).name().map(|n| n.to_string())).collect())
                        .unwrap_or_default(),
                });
            }
        }
        out.sort_by(|a, b| a.start.cmp(&b.start));
        Ok(out)
    }

    pub fn reminders() -> Result<Vec<RemoteTask>> {
        if access(Kind::Reminders) != Access::Granted {
            return Ok(Vec::new());
        }
        let store = unsafe { EKEventStore::new() };
        let pred = unsafe { store.predicateForIncompleteRemindersWithDueDateStarting_ending_calendars(None, None, None) };
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |found: *mut NSArray<EKReminder>| {
            let mut out = Vec::new();
            if let Some(found) = unsafe { Retained::retain(found) } {
                for i in 0..found.count() {
                    let r = found.objectAtIndex(i);
                    unsafe {
                        let cal = r.calendar();
                        out.push(RemoteTask {
                            id: r.calendarItemIdentifier().to_string(),
                            source: "apple".into(),
                            list_id: cal.as_ref().map(|c| c.calendarIdentifier().to_string()).unwrap_or_default(),
                            list: cal.map(|c| c.title().to_string()).unwrap_or_else(|| "Reminders".into()),
                            title: r.title().to_string(),
                            done: r.isCompleted(),
                            due: r.dueDateComponents().and_then(|c| {
                                let (y, m, d) = (c.year(), c.month(), c.day());
                                (y > 0 && y < 10000 && m > 0 && m <= 12 && d > 0 && d <= 31)
                                    .then(|| format!("{y:04}-{m:02}-{d:02}"))
                            }),
                        });
                    }
                }
            }
            let _ = tx.send(out);
        });
        unsafe {
            store.fetchRemindersMatchingPredicate_completion(&pred, &block);
        }
        rx.recv_timeout(Duration::from_secs(30)).map_err(|_| msg("Reminders didn't answer. Try again."))
    }

    pub fn set_reminder_done(id: &str, done: bool) -> Result<()> {
        let store = unsafe { EKEventStore::new() };
        let item = unsafe { store.calendarItemWithIdentifier(&NSString::from_str(id)) }
            .ok_or_else(|| msg("That reminder no longer exists."))?;
        let reminder: Retained<EKReminder> =
            item.downcast().map_err(|_| msg("That item isn't a reminder."))?;
        unsafe {
            reminder.setCompleted(done);
            store
                .saveReminder_commit_error(&reminder, true)
                .map_err(|e| msg(format!("Couldn't update the reminder: {}", e.localizedDescription())))?;
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod imp {
    use super::*;
    use crate::error::msg;
    use chrono::{DateTime, Utc};

    pub fn access(_: Kind) -> Access {
        Access::Unsupported
    }
    pub fn request(_: Kind) -> Result<Access> {
        Ok(Access::Unsupported)
    }
    pub fn events(_: DateTime<Utc>, _: DateTime<Utc>) -> Result<Vec<CalEvent>> {
        Ok(Vec::new())
    }
    pub fn reminders() -> Result<Vec<RemoteTask>> {
        Ok(Vec::new())
    }
    pub fn set_reminder_done(_: &str, _: bool) -> Result<()> {
        Err(msg("Apple Reminders is only on iPhone and Mac."))
    }
}

pub use imp::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_states_reach_the_interface_in_snake_case() {
        let names: Vec<String> = [Access::Unsupported, Access::NotAsked, Access::Granted, Access::Denied]
            .iter()
            .map(|a| serde_json::to_value(a).unwrap().as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, ["unsupported", "not_asked", "granted", "denied"]);
    }

    /// Only the status is read: asking for access, or reading events and reminders, would touch
    /// the calendars of whoever runs the tests.
    #[test]
    fn eventkit_status_is_known_on_apple_platforms() {
        for kind in [Kind::Calendar, Kind::Reminders] {
            let a = access(kind);
            if cfg!(any(target_os = "macos", target_os = "ios")) {
                assert_ne!(a, Access::Unsupported);
            } else {
                assert_eq!(a, Access::Unsupported);
            }
        }
    }
}
