//! Headless UI tests of the header bar's layout in narrow windows: the in-window menus, the
//! centred sequence title and the right-hand group (workspace name and quick actions) never
//! overlap. Menus that don't fit move into the overflow menu (`menu.more`), and every menu stays
//! reachable from the bar or that menu.

use std::sync::mpsc::{Sender, channel};

use egui_kittest::Harness;
use filmcraft_engine::Session;
use filmcraft_ui_egui::FilmcraftApp;
use filmcraft_ui_egui::control::ControlRequest;
use filmcraft_ui_egui::menus::MENUS;
use serde_json::{Value, json};

const H: f32 = 700.0;

struct Driver {
    harness: Harness<'static, FilmcraftApp>,
    tx: Sender<ControlRequest>,
}

/// One registered element: its automation id and rect (`[x, y, w, h]`).
struct El {
    id: String,
    rect: [f32; 4],
}

impl El {
    fn right(&self) -> f32 {
        self.rect[0] + self.rect[2]
    }

    /// The two rects share an area (touching edges is not overlapping).
    fn overlaps(&self, other: &El) -> bool {
        let [ax, ay, aw, ah] = self.rect;
        let [bx, by, bw, bh] = other.rect;
        ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah
    }
}

impl Driver {
    fn new(width: f32) -> Self {
        let mut session = Session::default();
        session.execute("file.openDemoProject", json!({})).expect("demo project");
        let (tx, rx) = channel();
        let mut app = FilmcraftApp::new(session).with_control(rx);
        // The in-window menu bar, as on Windows, Linux and the web build.
        app.ui.show_menu_bar = true;
        let harness = Harness::builder().with_size(egui::vec2(width, H)).with_max_steps(10_000).build_eframe(move |_cc| app);
        let mut d = Driver { harness, tx };
        d.frames(4);
        d
    }

    fn frames(&mut self, n: usize) {
        for _ in 0..n {
            let ctx = self.harness.ctx.clone();
            let mut raw = std::mem::take(self.harness.input_mut());
            eframe::App::raw_input_hook(self.harness.state_mut(), &ctx, &mut raw);
            *self.harness.input_mut() = raw;
            self.harness.step();
        }
    }

    fn ok(&mut self, method: &str, params: Value) -> Value {
        let (req, reply) = ControlRequest::new(method, params.clone());
        self.tx.send(req).unwrap();
        for _ in 0..600 {
            self.frames(1);
            if let Ok(v) = reply.try_recv() {
                assert_eq!(v["ok"], json!(true), "{method} {params} failed: {v}");
                return v["result"].clone();
            }
        }
        panic!("no reply to {method} {params}");
    }

    fn elements(&mut self, prefix: &str) -> Vec<El> {
        let v = self.ok("ui.elements", json!({"prefix": prefix}));
        v.as_array()
            .unwrap()
            .iter()
            .map(|e| {
                let r = &e["rect"];
                let f = |i: usize| r[i].as_f64().unwrap() as f32;
                El { id: e["id"].as_str().unwrap().to_string(), rect: [f(0), f(1), f(2), f(3)] }
            })
            .collect()
    }

    /// The header's groups: the menu-bar titles (`menu.<Menu>` and `menu.more`), the sequence title
    /// (`header.title`, absent when there is no room for it), the workspace name, and the rest of
    /// the header (Home, mode tabs, quick actions).
    fn header(&mut self) -> Header {
        let menus: Vec<El> = self.elements("menu.").into_iter().filter(|e| e.id == "menu.more" || MENUS.iter().any(|m| e.id == format!("menu.{m}"))).collect();
        let mut rest = self.elements("header.");
        let take = |rest: &mut Vec<El>, id: &str| rest.iter().position(|e| e.id == id).map(|i| rest.remove(i));
        let title = take(&mut rest, "header.title");
        let ws_name = take(&mut rest, "header.workspaceName");
        Header { menus, title, ws_name, rest }
    }

    fn set_size(&mut self, width: f32) {
        self.harness.set_size(egui::vec2(width, H));
        self.frames(4);
    }
}

struct Header {
    menus: Vec<El>,
    title: Option<El>,
    ws_name: Option<El>,
    rest: Vec<El>,
}

impl Header {
    /// No two of the menus, the title, the workspace name and the other header controls overlap,
    /// and everything lies inside the window. The workspace name and the Workspaces button beside
    /// it are one control (both open the workspace menu), so that pair is not checked.
    fn assert_no_overlap(&self, width: f32) {
        assert!(!self.menus.is_empty(), "{width}: no menu titles drawn");
        let mut right: Vec<&El> = self.rest.iter().collect();
        right.extend(self.ws_name.iter());
        right.extend(self.title.iter());
        for m in &self.menus {
            assert!(m.right() <= width, "{width}: {} runs out of the window: {:?}", m.id, m.rect);
            for o in &right {
                assert!(!m.overlaps(o), "{width}: {} {:?} overlaps {} {:?}", m.id, m.rect, o.id, o.rect);
            }
        }
        if let Some(t) = &self.title {
            for o in self.rest.iter().chain(self.ws_name.iter()) {
                assert!(!t.overlaps(o), "{width}: the title {:?} overlaps {} {:?}", t.rect, o.id, o.rect);
            }
        }
        if let Some(ws) = &self.ws_name {
            for o in self.rest.iter().filter(|o| o.id != "header.workspaces") {
                assert!(!ws.overlaps(o), "{width}: the workspace name {:?} overlaps {} {:?}", ws.rect, o.id, o.rect);
            }
        }
    }

    fn in_bar(&self) -> Vec<&str> {
        MENUS.iter().copied().filter(|m| self.menus.iter().any(|e| e.id == format!("menu.{m}"))).collect()
    }
}

/// The reported bug: at 800 points the right-hand group ("EDITING" and the icons) was drawn over
/// the menus. Now the menus that don't fit are in the overflow menu, the workspace name is still
/// shown, nothing overlaps, and every menu can be reached.
#[test]
fn header_at_800_points_has_no_overlaps_and_every_menu_is_reachable() {
    let mut d = Driver::new(800.0);
    let h = d.header();
    h.assert_no_overlap(800.0);
    assert!(h.ws_name.is_some(), "the workspace name is shown at 800 points");
    let in_bar: Vec<String> = h.in_bar().into_iter().map(str::to_string).collect();
    assert!(!in_bar.is_empty() && in_bar.len() < MENUS.len(), "some menus in the bar, the rest in the overflow menu: {in_bar:?}");
    assert_eq!(in_bar, MENUS[..in_bar.len()].iter().map(|m| m.to_string()).collect::<Vec<_>>(), "the bar keeps the menus in order");
    assert!(h.menus.iter().any(|e| e.id == "menu.more"), "no overflow menu");

    // The overflow menu lists the rest, each opening its own menu.
    d.ok("ui.click", json!({"id": "menu.more"}));
    d.frames(2);
    let listed: Vec<String> = d.elements("menu.").into_iter().map(|e| e.id).collect();
    for m in &MENUS[in_bar.len()..] {
        assert!(listed.contains(&format!("menu.{m}")), "{m} is not in the overflow menu: {listed:?}");
    }
    d.ok("ui.click", json!({"id": "menu.Help"}));
    d.frames(2);
    assert!(d.elements("menu.help.").iter().any(|e| e.id.starts_with("menu.help.")), "Help did not open from the overflow menu");
    assert!(d.harness.state().ui_error.is_none(), "{:?}", d.harness.state().ui_error);
}

/// From 800 points up to a wide window nothing in the header overlaps; once there is room every
/// menu is back in the bar and the title is shown.
#[test]
fn header_has_no_overlaps_from_800_points_up() {
    let mut d = Driver::new(800.0);
    let mut width = 800.0;
    while width <= 1600.0 {
        d.set_size(width);
        d.header().assert_no_overlap(width);
        width += 40.0;
    }
    let h = d.header();
    assert_eq!(h.in_bar(), MENUS.to_vec(), "every menu in the bar at 1600 points");
    assert!(!h.menus.iter().any(|e| e.id == "menu.more"), "no overflow menu when everything fits");
    assert!(h.title.is_some(), "the sequence title is shown at 1600 points");
    assert!(h.ws_name.is_some());
    assert!(d.harness.state().ui_error.is_none(), "{:?}", d.harness.state().ui_error);
}

/// German menu names are longer than English; at 800 points they still don't overlap.
#[test]
fn german_header_at_800_points_has_no_overlaps() {
    let mut d = Driver::new(800.0);
    d.ok("ui.menu.invoke", json!({"id": "app.language.german"}));
    d.frames(4);
    d.header().assert_no_overlap(800.0);
    d.ok("ui.menu.invoke", json!({"id": "app.language.english"}));
}
