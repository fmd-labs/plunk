import {mergeAttributes, Node} from '@tiptap/core';

/**
 * A call-to-action button (fork D34): a link styled as a button, on a line of its own.
 *
 * It is written as `<p class="email-button-row"><a class="email-button" href="…">Label</a></p>`. Both
 * classes are on the visual editor's allowlist, so a body with a button stays editable here, and the
 * look comes from CSS: Plunk's own wrapper styles `.email-button`, and a layout's CSS can restyle it.
 * The link may hold a placeholder, such as `{{ data.url }}`.
 */

export interface EmailButtonAttributes {
  href: string;
  label: string;
  align: 'left' | 'center' | 'right';
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    emailButton: {
      /** Insert a button, or change the one selected. */
      setEmailButton: (attributes: Partial<EmailButtonAttributes> & {href: string}) => ReturnType;
    };
  }
}

const ALIGNMENTS = ['left', 'center', 'right'] as const;

export const EmailButton = Node.create({
  name: 'emailButton',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      href: {default: ''},
      label: {default: 'Button'},
      align: {default: 'left'},
    };
  },

  parseHTML() {
    return [
      {
        tag: 'p.email-button-row',
        // Ahead of the paragraph rule, which would otherwise take the row as text with a link.
        priority: 60,
        getAttrs: element => {
          const link = (element as HTMLElement).querySelector('a.email-button');
          if (!link) {
            return false;
          }
          const align = (element as HTMLElement).style.textAlign;
          return {
            href: link.getAttribute('href') ?? '',
            label: link.textContent ?? '',
            align: (ALIGNMENTS as readonly string[]).includes(align) ? align : 'left',
          };
        },
      },
    ];
  },

  renderHTML({node}) {
    const {href, label, align} = node.attrs as EmailButtonAttributes;
    return [
      'p',
      mergeAttributes({class: 'email-button-row'}, align === 'left' ? {} : {style: `text-align: ${align}`}),
      ['a', {class: 'email-button', href, target: '_blank', rel: 'noopener noreferrer'}, label],
    ];
  },

  addNodeView() {
    return ({node}) => {
      const {label, align} = node.attrs as EmailButtonAttributes;
      const row = document.createElement('p');
      row.style.textAlign = align;
      row.style.margin = '24px 0';
      const button = document.createElement('span');
      button.textContent = label || 'Button';
      // The editor has no stylesheet of its own; this mirrors Plunk's default `.email-button` look.
      Object.assign(button.style, {
        display: 'inline-block',
        padding: '12px 20px',
        borderRadius: '6px',
        backgroundColor: '#171717',
        color: '#ffffff',
        fontWeight: '600',
        cursor: 'pointer',
      });
      row.append(button);
      return {dom: row};
    };
  },

  addCommands() {
    return {
      setEmailButton:
        attributes =>
        ({commands, editor}) => {
          if (editor.isActive(this.name)) {
            return commands.updateAttributes(this.name, attributes);
          }
          return commands.insertContent({type: this.name, attrs: attributes});
        },
    };
  },
});
