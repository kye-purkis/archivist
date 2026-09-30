import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { genreSelectOptions } from "../../catalogue-ui-helpers";

const emptyGenreValue = "__no_genre__";
const genreValuePrefix = "genre:";

type GenreSelectProps = {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  existingGenres: readonly string[];
  emptyLabel: string;
  className?: string;
  invalid?: boolean;
  describedBy?: string;
};

export function GenreSelect({
  id,
  value,
  onValueChange,
  existingGenres,
  emptyLabel,
  className,
  invalid,
  describedBy,
}: GenreSelectProps) {
  const options = genreSelectOptions(existingGenres, value);
  const selectedGenre =
    options.find(
      (genre) => genre.toLowerCase() === value.trim().toLowerCase(),
    ) ?? value.trim();

  return (
    <Select
      value={
        selectedGenre
          ? `${genreValuePrefix}${selectedGenre}`
          : emptyGenreValue
      }
      onValueChange={(selection) =>
        onValueChange(
          selection === emptyGenreValue
            ? ""
            : selection.slice(genreValuePrefix.length),
        )
      }
    >
      <SelectTrigger
        id={id}
        className={className}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={emptyGenreValue}>{emptyLabel}</SelectItem>
        {options.map((genre) => (
          <SelectItem key={genre} value={`${genreValuePrefix}${genre}`}>
            {genre}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
