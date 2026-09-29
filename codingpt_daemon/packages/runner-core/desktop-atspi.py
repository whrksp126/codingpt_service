#!/usr/bin/env python3
# 에이전트 PC(Linux) 접근성 트리 덤퍼 — macOS 의 desktop-ax.jxa.js 에 대응.
#  AT-SPI(pyatspi)로 열린 앱들의 접근성 트리를 걷어 JXA 와 **같은 JSON 형식**으로 낸다:
#   { app, pid, nodes:[{ i, role, title, desc, value, x, y, w, h, disabled, focused }], truncated }
#  좌표는 0~1 비율(화면 크기로 정규화) — axFind/axTap/cpt 렌더러가 그대로 쓴다(분기 없음).
#
#  인자: [target] [--screen WxH]
#   target = 앱 이름(부분일치) 또는 pid. 없으면 **앞 창**을 가진 앱(활성) 하나.
#   --screen = 화면 픽셀 크기(정규화용). desktop.js 가 status 의 display 로 넘긴다. 없으면 xdotool 로 조회.
import sys, json, subprocess

def screen_size(argv):
    for i, a in enumerate(argv):
        if a == '--screen' and i + 1 < len(argv):
            try:
                w, h = argv[i + 1].lower().split('x'); return int(w), int(h)
            except Exception:
                pass
    try:
        out = subprocess.check_output(['xdotool', 'getdisplaygeometry'], text=True, timeout=5).split()
        return int(out[0]), int(out[1])
    except Exception:
        return 1440, 900

def fail(msg):
    print(json.dumps({'error': msg})); sys.exit(0)

try:
    import pyatspi
except Exception as e:
    fail('AT-SPI(pyatspi) 를 불러오지 못했어요: %s' % e)

# AT-SPI role → macOS 스타일 role 이름(axFind 의 AX_CLICKABLE·cpt 필터와 맞춘다)
ROLE = {
    'push button': 'Button', 'toggle button': 'Button', 'button': 'Button',
    'check box': 'CheckBox', 'check menu item': 'CheckBox',
    'radio button': 'RadioButton', 'radio menu item': 'RadioButton',
    'menu item': 'MenuItem', 'menu': 'MenuItem', 'menu bar': 'MenuBarItem',
    'link': 'Link', 'hyperlink': 'Link',
    'text': 'TextField', 'entry': 'TextField', 'password text': 'TextField',
    'paragraph': 'StaticText', 'label': 'StaticText', 'static': 'StaticText',
    'combo box': 'ComboBox', 'page tab': 'Tab', 'page tab list': 'TabGroup',
    'table cell': 'Cell', 'table row': 'Row', 'list item': 'Cell',
    'slider': 'Slider', 'spin button': 'Incrementor', 'image': 'Image',
    'heading': 'Heading', 'frame': 'Window', 'dialog': 'Dialog', 'window': 'Window',
    'panel': 'Group', 'filler': 'Group', 'scroll pane': 'Group', 'tool bar': 'Group',
}

def role_name(acc):
    try:
        r = acc.getRoleName()
    except Exception:
        return 'Group'
    return ROLE.get(r, ''.join(w.capitalize() for w in r.split()) or 'Group')

def state_has(acc, st):
    try:
        return acc.getState().contains(st)
    except Exception:
        return False

def main():
    argv = sys.argv[1:]
    target = None
    for a in argv:
        if not a.startswith('--'):
            target = a; break
    SW, SH = screen_size(argv)
    desktop = pyatspi.Registry.getDesktop(0)

    apps = []
    for i in range(desktop.childCount):
        try:
            app = desktop.getChildAtIndex(i)
        except Exception:
            continue
        if app is None:
            continue
        name = app.name or ''
        try:
            pid = app.get_process_id()
        except Exception:
            pid = 0
        if target:
            if target.isdigit():
                if str(pid) != target:
                    continue
            elif target.lower() not in name.lower():
                continue
        apps.append((app, name, pid))

    # target 없으면 활성 창(focused 자식이 있거나 active window)을 가진 앱을 고른다
    if not target:
        best = None
        for app, name, pid in apps:
            for j in range(app.childCount):
                try:
                    win = app.getChildAtIndex(j)
                    if win and (state_has(win, pyatspi.STATE_ACTIVE) or state_has(win, pyatspi.STATE_FOCUSED)):
                        best = (app, name, pid); break
                except Exception:
                    continue
            if best:
                break
        apps = [best] if best else (apps[:1] if apps else [])

    nodes = []
    counter = [0]
    MAX = 1500
    truncated = [False]

    def walk(acc, depth):
        if len(nodes) >= MAX:
            truncated[0] = True; return
        try:
            role = role_name(acc)
            comp = acc.queryComponent()
            ext = comp.getExtents(pyatspi.XY_SCREEN)  # (x, y, w, h) px
            x, y, w, h = ext.x, ext.y, ext.width, ext.height
        except Exception:
            x = y = w = h = 0; role = role_name(acc)
        title = acc.name or ''
        desc = ''
        try:
            desc = acc.description or ''
        except Exception:
            pass
        value = ''
        try:
            value = str(acc.queryValue().currentValue)
        except Exception:
            try:
                txt = acc.queryText(); value = txt.getText(0, txt.characterCount)
            except Exception:
                value = ''
        # 화면 밖·비정상 좌표(숨은/언맵 위젯)는 클릭 불가 — 좌표를 0 으로 눕혀 axFind 가 거른다(w/h>0 조건).
        on_screen = (0 <= x <= SW * 1.5 and 0 <= y <= SH * 1.5)
        if not on_screen:
            x = y = w = h = 0
        counter[0] += 1
        nodes.append({
            'i': counter[0], 'role': role,
            'title': title or None, 'desc': desc or None,
            'value': (value[:120] or None) if value else None,
            'x': round(x / SW, 4) if w > 0 else 0, 'y': round(y / SH, 4) if h > 0 else 0,
            'w': round(w / SW, 4), 'h': round(h / SH, 4),
            'disabled': not state_has(acc, pyatspi.STATE_ENABLED),
            'focused': state_has(acc, pyatspi.STATE_FOCUSED),
        })
        try:
            n = acc.childCount
        except Exception:
            n = 0
        for k in range(min(n, 200)):
            try:
                ch = acc.getChildAtIndex(k)
            except Exception:
                continue
            if ch is not None:
                walk(ch, depth + 1)

    app_name = apps[0][1] if apps else ''
    app_pid = apps[0][2] if apps else 0
    for app, name, pid in apps:
        for j in range(app.childCount):
            try:
                win = app.getChildAtIndex(j)
            except Exception:
                continue
            if win is not None:
                walk(win, 0)

    print(json.dumps({'app': app_name or 'Desktop', 'pid': app_pid, 'nodes': nodes, 'truncated': truncated[0]}))

main()
